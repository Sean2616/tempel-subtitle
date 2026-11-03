const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 7860;

const uploadDir = 'uploads';
const outputDir = 'outputs';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 } // Maksimal 500 MB
});

app.use(express.static('public'));

const jobs = {};

// Konversi HH:MM:SS.ms ke total detik
function timeToSeconds(h, m, s) {
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

// Konversi detik ke format MM:SS atau HH:MM:SS
function formatSeconds(sec) {
    if (!sec || sec < 0 || !isFinite(sec)) return 'Menghitung...';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    if (hrs > 0) return `${hrs}j ${mins}m ${secs}d`;
    if (mins > 0) return `${mins} menit ${secs} detik`;
    return `${secs} detik`;
}

// 1. Endpoint Mulai Proses Video
app.post('/process', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'subtitle', maxCount: 1 }]), (req, res) => {
    if (!req.files || !req.files.video || !req.files.subtitle) {
        return res.status(400).json({ error: 'Harap unggah file video dan subtitle (.srt).' });
    }

    const jobId = Date.now().toString() + Math.round(Math.random() * 1000);
    const mode = req.body.mode || 'soft';
    const videoPath = req.files.video[0].path.replace(/\\/g, '/');
    const subPath = req.files.subtitle[0].path.replace(/\\/g, '/');
    const outputFileName = `Subtitle_Video_${jobId}.mp4`;
    const outputPath = `${outputDir}/${outputFileName}`;

    jobs[jobId] = {
        status: 'processing',
        mode: mode,
        progress: 0,
        currentTimeStr: '00:00:00',
        totalDurationStr: '00:00:00',
        totalDuration: 0,
        fps: '0',
        speed: '0x',
        eta: 'Menghitung...',
        log: 'Menganalisis file video dan subtitle...',
        outputPath,
        outputFileName,
        error: null,
        startTime: Date.now()
    };

    let ffmpegArgs = [];
    if (mode === 'soft') {
        ffmpegArgs = [
            '-i', videoPath,
            '-i', subPath,
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-c:s', 'mov_text',
            '-metadata:s:s:0', 'language=ind',
            '-y', outputPath
        ];
    } else {
        ffmpegArgs = [
            '-i', videoPath,
            '-vf', `subtitles=${subPath}:force_style='FontName=Liberation Sans,Fontsize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1'`,
            '-c:v', 'libx264',
            '-crf', '17',
            '-preset', 'fast',
            '-c:a', 'copy',
            '-y', outputPath
        ];
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    let headerBuffer = '';

    ffmpeg.stderr.on('data', (data) => {
        const text = data.toString();
        const job = jobs[jobId];
        if (!job) return;

        // Simpan buffer awal untuk memastikan informasi Duration tidak terpotong
        if (!job.totalDuration && headerBuffer.length < 20000) {
            headerBuffer += text;
            const durMatch = headerBuffer.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
            if (durMatch) {
                job.totalDuration = timeToSeconds(durMatch[1], durMatch[2], `${durMatch[3]}.${durMatch[4]}`);
                job.totalDurationStr = `${durMatch[1]}:${durMatch[2]}:${durMatch[3]}`;
                job.log = `Durasi video terdeteksi: ${job.totalDurationStr}. Memulai proses tempel subtitle...`;
            }
        }

        // Ambil update waktu terakhir dari chunk log FFmpeg
        const timeMatches = [...text.matchAll(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/g)];
        if (timeMatches.length > 0) {
            const lastMatch = timeMatches[timeMatches.length - 1];
            const h = lastMatch[1], m = lastMatch[2], s = lastMatch[3], ms = lastMatch[4];
            const currentSec = timeToSeconds(h, m, `${s}.${ms}`);
            job.currentTimeStr = `${h}:${m}:${s}`;

            // Ambil FPS dan Speed jika ada
            const fpsMatch = text.match(/fps=\s*([\d.]+)/);
            const speedMatch = text.match(/speed=\s*([\d.]+x)/);
            if (fpsMatch) job.fps = fpsMatch[1];
            if (speedMatch) job.speed = speedMatch[1];

            if (job.totalDuration > 0) {
                const percent = Math.min(99, Math.max(1, Math.round((currentSec / job.totalDuration) * 100)));
                job.progress = percent;

                // Hitung Estimasi Sisa Waktu (ETA)
                const speedVal = parseFloat(job.speed);
                if (speedVal && speedVal > 0) {
                    const remainingVideoSec = Math.max(0, job.totalDuration - currentSec);
                    job.eta = formatSeconds(remainingVideoSec / speedVal);
                } else {
                    const elapsedSec = (Date.now() - job.startTime) / 1000;
                    const estimatedTotalSec = (elapsedSec / percent) * 100;
                    job.eta = formatSeconds(Math.max(0, estimatedTotalSec - elapsedSec));
                }

                job.log = `Memproses posisi ${job.currentTimeStr} dari ${job.totalDurationStr} (${job.fps} FPS | Kecepatan ${job.speed})`;
            }
        }
    });

    ffmpeg.on('close', (code) => {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(subPath)) fs.unlinkSync(subPath);

        const job = jobs[jobId];
        if (!job) return;

        if (code === 0) {
            job.status = 'done';
            job.progress = 100;
            job.currentTimeStr = job.totalDurationStr;
            job.eta = '0 detik (Selesai)';
            job.log = '✅ Proses penggabungan subtitle selesai 100%!';
        } else {
            job.status = 'error';
            job.error = 'Gagal memproses video. Pastikan file subtitle (.srt) memiliki format yang benar.';
        }
    });

    res.json({ jobId });
});

// 2. Endpoint Polling Status Detail
app.get('/status/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Proses tidak ditemukan.' });

    res.json({
        status: job.status,
        mode: job.mode,
        progress: job.progress,
        currentTimeStr: job.currentTimeStr,
        totalDurationStr: job.totalDurationStr,
        fps: job.fps,
        speed: job.speed,
        eta: job.eta,
        log: job.log,
        error: job.error
    });
});

// 3. Endpoint Unduh Hasil Video
app.get('/download/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs[jobId];
    if (!job || job.status !== 'done' || !fs.existsSync(job.outputPath)) {
        return res.status(404).send('File tidak ditemukan atau sudah terhapus.');
    }

    const stat = fs.statSync(job.outputPath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${job.outputFileName}"`);

    const fileStream = fs.createReadStream(job.outputPath);
    fileStream.pipe(res);

    // Hapus file 5 menit setelah diunduh agar user masih bisa klik "Unduh Ulang" jika perlu
    fileStream.on('close', () => {
        setTimeout(() => {
            if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
            delete jobs[jobId];
        }, 5 * 60 * 1000);
    });
});

// Auto-Cleanup setiap 15 menit untuk file yang berumur > 30 menit
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;
    [uploadDir, outputDir].forEach(dir => {
        fs.readdir(dir, (err, files) => {
            if (err) return;
            files.forEach(file => {
                const filePath = path.join(dir, file);
                fs.stat(filePath, (err, stats) => {
                    if (!err && now - stats.mtimeMs > maxAge) fs.unlink(filePath, () => {});
                });
            });
        });
    });
}, 15 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});
