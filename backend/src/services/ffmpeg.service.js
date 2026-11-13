const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const ffmpeg = require('fluent-ffmpeg');
const { ffmpegPath, ffprobePath, mediaDir, maxVideoBytes } = require('../config/env');

const execFileAsync = promisify(execFile);
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

async function assertAvailable() {
  // Confirme que les exécutables configurés sont accessibles avant de traiter les uploads.
  try {
    await execFileAsync(ffmpegPath, ['-version'], { windowsHide: true });
    await execFileAsync(ffprobePath, ['-version'], { windowsHide: true });
  } catch (error) {
    const unavailable = new Error('FFmpeg et FFprobe doivent être installés et accessibles via PATH ou FFMPEG_PATH/FFPROBE_PATH.');
    unavailable.status = 503;
    unavailable.cause = error;
    throw unavailable;
  }
}

function probe(filePath) {
  // Lit la durée, les dimensions et les codecs sans modifier la vidéo source.
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) return reject(error);
      resolve(metadata);
    });
  });
}

/**
 * Transcode une variante HLS adaptative (segments courts .ts de 2 secondes).
 * Permet un streaming fluide qui s'adapte à la qualité de connexion du téléphone.
 * 
 * @param {string} inputPath - Chemin du fichier vidéo temporaire assemblé
 * @param {string} outputDirectory - Dossier cible (ex: 240p ou 480p)
 * @param {number} height - Hauteur en pixels (ex: 240 ou 480)
 * @param {string} bitrate - Débit vidéo alloué (ex: '350k' ou '900k')
 */
function transcodeVariant(inputPath, outputDirectory, height, bitrate) {
  return new Promise((resolve, reject) => {
    const playlist = path.join(outputDirectory, 'index.m3u8');
    const segmentPattern = path.join(outputDirectory, 'segment_%05d.ts');
    ffmpeg(inputPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 0:a:0?',
        '-vf', `scale=-2:min(ih\\,${height})`,
        '-c:v libx264',
        '-preset veryfast',
        '-profile:v main',
        '-pix_fmt yuv420p',
        '-b:v', bitrate,
        '-maxrate', bitrate,
        '-bufsize', `${parseInt(bitrate, 10) * 2}k`,
        '-c:a aac',
        '-b:a 64k',
        '-ac 2',
        '-ar 44100',
        '-f hls',
        '-hls_time 2',                       // Découpage en tranches vidéo de 2 secondes
        '-hls_playlist_type vod',            // Lecture à la demande (VOD)
        '-hls_flags independent_segments',   // Chaque segment .ts peut être décodé indépendamment
        '-force_key_frames', 'expr:gte(t,n_forced*2)', // Force une clé (I-frame) toutes les 2s
        '-sc_threshold 0',
        '-hls_segment_filename', segmentPattern,
      ])
      .output(playlist)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

/**
 * Transcode et compresse un fichier MP4 direct avec optimisation "FastStart".
 * L'argument '-movflags +faststart' déplace les métadonnées (le 'moov atom')
 * au tout début du fichier MP4. Ainsi, le navigateur mobile démarre la lecture
 * immédiatement dès les premiers Ko reçus, sans télécharger toute la vidéo.
 */
function transcodeMp4(inputPath, outputPath, height = 480, bitrate = '900k') {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 0:a:0?',
        '-vf', `scale=-2:min(ih\\,${height})`,
        '-c:v libx264',
        '-preset veryfast',
        '-profile:v main',
        '-pix_fmt yuv420p',
        '-movflags +faststart',               // <-- FastStart : moov atom au début du fichier
        '-b:v', bitrate,
        '-maxrate', bitrate,
        '-bufsize', `${parseInt(bitrate, 10) * 2}k`,
        '-c:a aac',
        '-b:a 96k',
        '-ac 2',
        '-ar 44100',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function extractPoster(inputPath, posterPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputOptions(['-ss 0'])
      .frames(1)
      .output(posterPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function processVideo(inputPath, mediaId) {
  // Génère le HLS adaptatif, le MP4 de secours et l'affiche de la publication.
  const stat = await fs.stat(inputPath);
  if (maxVideoBytes > 0 && stat.size > maxVideoBytes) {
    const error = new Error('La vidéo dépasse la taille maximale autorisée.');
    error.status = 413;
    throw error;
  }

  await assertAvailable();
  const metadata = await probe(inputPath);
  const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video');
  const duration = Number(metadata.format.duration);
  if (!videoStream || !Number.isFinite(duration) || duration <= 0) {
    const error = new Error('Le fichier ne contient pas une vidéo lisible.');
    error.status = 415;
    throw error;
  }
  const directory = path.join(mediaDir, 'videos', String(mediaId));
  const lowDirectory = path.join(directory, '240p');
  const highDirectory = path.join(directory, '480p');
  const mp4Path = path.join(directory, 'video.mp4');
  await fs.mkdir(lowDirectory, { recursive: true });
  await fs.mkdir(highDirectory, { recursive: true });
  await Promise.all([
    transcodeVariant(inputPath, lowDirectory, 240, '350k'),
    transcodeVariant(inputPath, highDirectory, 480, '900k'),
    transcodeMp4(inputPath, mp4Path, 480, '900k'),
  ]);
  const posterPath = path.join(directory, 'poster.jpg');
  await extractPoster(inputPath, posterPath);

  const masterPath = path.join(directory, 'master.m3u8');
  const resolution = (height) => {
    const outputHeight = Math.min(height, videoStream.height);
    const outputWidth = Math.max(2, Math.floor((outputHeight * videoStream.width / videoStream.height) / 2) * 2);
    return `${outputWidth}x${outputHeight}`;
  };
  await fs.writeFile(
    masterPath,
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=${resolution(240)}`,
      '240p/index.m3u8',
      `#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=${resolution(480)}`,
      '480p/index.m3u8',
      '',
    ].join('\n'),
    'utf8'
  );
  return {
    storageKey: path.posix.join('videos', String(mediaId), 'master.m3u8'),
    posterKey: path.posix.join('videos', String(mediaId), 'poster.jpg'),
    mp4Key: path.posix.join('videos', String(mediaId), 'video.mp4'),
    width: videoStream.width || null,
    height: videoStream.height || null,
    duration,
  };
}

module.exports = { assertAvailable, processVideo, transcodeMp4, transcodeVariant };
