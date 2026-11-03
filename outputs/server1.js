const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Buat folder uploads & outputs jika belum ada
const uploadDir = 'uploads';
const outputDir = 'outputs';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

// Konfigurasi penyimpanan file upload menggunakan Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`);
    }
});
const upload = multer({ storage });

app.use(express.static('public'));

// Endpoint untuk memproses video dan subtitle
app.post('/process', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'subtitle', maxCount: 1 }]), (req, res) => {
    if (!req.files || !req.files.video || !req.files.subtitle) {
        return res.status(400).json({ error: 'Harap unggah file video dan subtitle (.srt).' });
    }

    const mode = req.body.mode || 'soft'; // 'soft' atau 'hard'
    const videoPath = req.files.video[0].path.replace(/\\/g, '/'); // Normalisasi path untuk Windows/Linux
    const subPath = req.files.subtitle[0].path.replace(/\\/g, '/');
    const outputFileName = `hasil-${Date.now()}.mp4`;
    const outputPath = `${outputDir}/${outputFileName}`;

    let ffmpegArgs = [];

    if (mode === 'soft') {
        // MODE 1: SOFT SUBTITLE (100% Tanpa Render Ulang / 0% Quality Loss)
        ffmpegArgs = [
            '-i', videoPath,
            '-i', subPath,
            '-c:v', 'copy',          // Salin video asli tanpa kompresi
            '-c:a', 'copy',          // Salin audio asli tanpa kompresi
            '-c:s', 'mov_text',      // Format subtitle untuk MP4
            '-metadata:s:s:0', 'language=ind',
            '-y', outputPath
        ];
    } else {
        // MODE 2: HARD SUBTITLE / BURN-IN (Visually Lossless CRF 17)
        ffmpegArgs = [
            '-i', videoPath,
            '-vf', `subtitles=${subPath}:force_style='Fontsize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1'`,
            '-c:v', 'libx264',
            '-crf', '17',            // CRF 17 = Kualitas setara aslinya (Visually Lossless)
            '-preset', 'fast',       // Kecepatan render optimal
            '-c:a', 'copy',          // Audio tidak dikompres ulang
            '-y', outputPath
        ];
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (data) => {
        console.log(`FFmpeg Log: ${data}`);
    });

    ffmpeg.on('close', (code) => {
        // Hapus file input sementara setelah selesai diproses
        fs.unlinkSync(videoPath);
        fs.unlinkSync(subPath);

        if (code === 0) {
            // Kirim file hasil ke user, lalu hapus dari server setelah terunduh
            res.download(outputPath, outputFileName, (err) => {
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            });
        } else {
            res.status(500).json({ error: 'Gagal memproses video. Pastikan format subtitle (.srt) valid.' });
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});