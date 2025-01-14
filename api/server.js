const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

const tempDir = '/tmp';

let downloadProgress = {};

app.get('/api/downloadprogress/:vodId', (req, res) => {
  const vodId = req.params.vodId;
  res.json({ progress: downloadProgress[vodId] || 0 });
});

function parseTime(time) {
  if (typeof time === 'number') {
    return time;
  }
  if (typeof time === 'string') {
    if (time.includes(':')) {
      const parts = time.split(':').map(Number);
      if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
      }
    } else {
      return parseInt(time, 10);
    }
  }
  console.error('Formato de tempo inválido:', time);
  return 0;
}

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function getStreamUrl(vodUrl) {
  return new Promise((resolve, reject) => {
    const youtubeDl = spawn('youtube-dl', ['-g', '-f', 'best', vodUrl]);
    let streamUrl = '';
    let errorOutput = '';

    youtubeDl.stdout.on('data', (data) => {
      streamUrl += data.toString();
    });

    youtubeDl.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.error('youtube-dl stderr:', data.toString());
    });

    youtubeDl.on('close', (code) => {
      if (code === 0 && streamUrl) {
        resolve(streamUrl.trim());
      } else {
        reject(new Error(`Failed to get stream URL: ${errorOutput}`));
      }
    });
  });
}

app.post('/api/downloadvod', async (req, res) => {
  const { vodId, vodUrl, start, end } = req.body;

  if (!vodUrl) {
    console.error('URL do VOD não fornecida');
    return res.status(400).json({ error: 'URL do VOD não fornecida' });
  }

  console.log('Recebida solicitação de download:', { vodId, vodUrl, start, end });

  try {
    console.log('Obtendo URL do stream com youtube-dl...');
    const streamUrl = await getStreamUrl(vodUrl);
    console.log('URL do stream obtida:', streamUrl);

    const startSeconds = parseTime(start);
    const endSeconds = parseTime(end);
    const duration = endSeconds - startSeconds;

    if (duration <= 0) {
      throw new Error('Duração inválida. O tempo de fim deve ser maior que o tempo de início.');
    }

    const outputFile = path.join(tempDir, `brkk_vod_${vodId}_${formatTime(startSeconds)}_${formatTime(endSeconds)}.mp4`);

    const ffmpegCommand = [
      '-ss', formatTime(startSeconds),
      '-i', streamUrl,
      '-t', formatTime(duration),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      outputFile
    ];

    console.log('Iniciando download com ffmpeg:', ffmpegCommand.join(' '));

    const ffmpeg = spawn('ffmpeg', ffmpegCommand);

    let errorLogs = '';
    ffmpeg.stderr.on('data', (data) => {
      errorLogs += data.toString();
      console.error('ffmpeg stderr:', data.toString());

      const output = data.toString();
      const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2})\.\d{2}/);

      if (timeMatch) {
        const [, hours, minutes, seconds] = timeMatch;
        const currentTime = parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);
        downloadProgress[vodId] = {
          duration: duration,
          current: Math.min(currentTime, duration)
        };
      }
    });

    ffmpeg.on('close', (code) => {
      console.log('ffmpeg processo fechado com código:', code);
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log('Arquivo criado com sucesso:', outputFile);
        const fileStats = fs.statSync(outputFile);
        console.log('Tamanho do arquivo:', fileStats.size, 'bytes');

        res.download(outputFile, (err) => {
          if (err) {
            console.error('Erro ao enviar o arquivo:', err);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Erro ao baixar o VOD: ' + err.message });
            }
          }
          fs.unlink(outputFile, (err) => {
            if (err) console.error('Erro ao remover arquivo temporário:', err);
          });
        });
      } else {
        console.error('Erro ao processar VOD. Código de saída:', code);
        if (!res.headersSent) {
          res.status(500).json({ error: `Erro ao processar VOD: ${errorLogs}` });
        }
      }
      delete downloadProgress[vodId];
    });

    ffmpeg.on('error', (err) => {
      console.error('Erro ao executar ffmpeg:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro ao executar ffmpeg: ' + err.message });
      }
      delete downloadProgress[vodId];
    });

  } catch (error) {
    console.error('Erro ao processar download:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro ao processar download: ' + error.message });
    }
  }
});

module.exports = app;

