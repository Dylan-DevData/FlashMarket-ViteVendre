require('dotenv').config();

const required = ['DATABASE_URL', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`Variables manquantes dans .env : ${missing.join(', ')}`);
  console.error('Copiez .env.example en .env puis renseignez les valeurs.');
  process.exit(1);
}

function positiveIntegerEnv(name, fallback) {
  // Les tailles maximales et durées doivent être des entiers strictement positifs.
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} doit être un entier strictement positif.`);
  }
  return value;
}

const configuredMaxVideoBytes = process.env.MAX_VIDEO_BYTES === undefined
  || process.env.MAX_VIDEO_BYTES === ''
  ? 0
  : Number(process.env.MAX_VIDEO_BYTES);
if (!Number.isSafeInteger(configuredMaxVideoBytes) || configuredMaxVideoBytes < 0) {
  throw new Error('MAX_VIDEO_BYTES doit être 0 (sans plafond) ou un entier positif en octets.');
}

const uploadChunkMaxBytes = positiveIntegerEnv('UPLOAD_CHUNK_MAX_BYTES', 4 * 1024 * 1024);
if (uploadChunkMaxBytes < 64 * 1024 || uploadChunkMaxBytes > 4 * 1024 * 1024) {
  throw new Error('UPLOAD_CHUNK_MAX_BYTES doit être compris entre 65536 et 4194304 octets.');
}

const requestTimeoutMs = positiveIntegerEnv('REQUEST_TIMEOUT_MS', 15 * 60 * 1000);
const headersTimeoutMs = positiveIntegerEnv('HEADERS_TIMEOUT_MS', 60 * 1000);
if (headersTimeoutMs > requestTimeoutMs) {
  throw new Error('HEADERS_TIMEOUT_MS doit être inférieur ou égal à REQUEST_TIMEOUT_MS.');
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  uploadDir: process.env.UPLOAD_DIR || require('path').join(__dirname, '..', '..', 'uploads'),
  mediaDir: process.env.MEDIA_DIR || require('path').join(__dirname, '..', '..', 'media'),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  maxVideoBytes: configuredMaxVideoBytes,
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES) || 10 * 1024 * 1024,
  uploadChunkMaxBytes,
  uploadSessionTtlHours: positiveIntegerEnv('UPLOAD_SESSION_TTL_HOURS', 168),
  requestTimeoutMs,
  headersTimeoutMs,
};
