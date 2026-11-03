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

// Konfigurasi Multer + Batas Ukuran File (Maksimal 500MB agar server aman)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 } // Limit 500 MB
});

app.use(express.static('public'));

// Penyimpanan status antrean proses (Job Queue)
const jobs = {};

// Fungsi bantu konversi waktu HH:MM:SS ke detik untuk hitung persentase
function timeToSeconds(h, m, s) {
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
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
        progress: 0,
        outputPath,
        outputFileName,
        error: null,
        createdAt: Date.now()
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
    let totalDuration = 0;

    ffmpeg.stderr.on('data', (data) => {
        const log = data.toString();

        // Ambil total durasi video
        const durMatch = log.match(/Duration:\s(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
        if (durMatch && !totalDuration) {
            totalDuration = timeToSeconds(durMatch[1], durMatch[2], durMatch[3]);
        }

        // Ambil waktu berjalan untuk update progress bar
        const timeMatch = log.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
        if (timeMatch && totalDuration > 0 && jobs[jobId]) {
            const currentTime = timeToSeconds(timeMatch[1], timeMatch[2], timeMatch[3]);
            const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));
            jobs[jobId].progress = percent;
        }
    });

    ffmpeg.on('close', (code) => {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (fs.existsSync(subPath)) fs.unlinkSync(subPath);

        if (!jobs[jobId]) return;

        if (code === 0) {
            jobs[jobId].status = 'done';
            jobs[jobId].progress = 100;
        } else {
            jobs[jobId].status = 'error';
            jobs[jobId].error = 'Gagal memproses video. Pastikan file subtitle (.srt) valid.';
        }
    });

    // Langsung balas dengan jobId agar browser tidak terkena Timeout
    res.json({ jobId });
});

// 2. Endpoint Cek Progress
app.get('/status/:jobId', (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Proses tidak ditemukan.' });
    res.json({ status: job.status, progress: job.progress, error: job.error });
});

// 3. Endpoint Unduh Hasil Video
app.get('/download/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs[jobId];
    if (!job || job.status !== 'done' || !fs.existsSync(job.outputPath)) {
        return res.status(404).send('File tidak ditemukan atau sudah kedaluwarsa.');
    }

    res.download(job.outputPath, job.outputFileName, () => {
        if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
        delete jobs[jobId];
    });
});

// Auto-Cleanup: Bersihkan file yang berumur lebih dari 30 menit setiap 15 menit
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;

    [uploadDir, outputDir].forEach(dir => {
        fs.readdir(dir, (err, files) => {
            if (err) return;
            files.forEach(file => {
                const filePath = path.join(dir, file);
                fs.stat(filePath, (err, stats) => {
                    if (!err && now - stats.mtimeMs > maxAge) {
                        fs.unlink(filePath, () => {});
                    }
                });
            });
        });
    });
}, 15 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Production berjalan di port ${PORT}`);
});