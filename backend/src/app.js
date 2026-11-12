const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');

const { corsOrigin, mediaDir } = require('./config/env');
const { query } = require('./config/db');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

const app = express();
fs.mkdirSync(mediaDir, { recursive: true });

// Sécurité Helmet : autorise les ressources cross-origin (images/vidéos lues par le frontend)
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// CORS : autorise le téléphone mobile à interroger l'API du PC.
// exposedHeaders : permet au lecteur vidéo frontend de lire les en-têtes HTTP de streaming (Content-Range).
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
  })
);
app.use(express.json({ limit: '1mb' }));

// Middleware de contrôle d'accès : vérifie en base que l'annonce associée est bien publiée
app.use('/media', async (req, res, next) => {
  const match = req.path.match(/^\/(images|videos)\/([1-9]\d*)\//);
  if (!match) return res.status(404).json({ error: 'Média introuvable.' });
  try {
    const { rows } = await query(
      `SELECT 1
       FROM media m
       JOIN posts p ON p.id = m.post_id
       WHERE m.id = $1 AND m.status = 'ready'
         AND p.status = 'published'
         AND (p.expires_at IS NULL OR p.expires_at > now())`,
      [match[2]]
    );
    if (!rows.length) return res.status(404).json({ error: 'Média introuvable.' });
    return next();
  } catch (error) {
    return next(error);
  }
});

// Distribution statique des fichiers médias (images, master.m3u8, segments .ts, video.mp4).
// Le support des requêtes partielles (Range requests HTTP 206) et les types MIME corrects
// permettent la lecture instantanée et le saut dans la vidéo (seeking) sur mobile.
app.use('/media', express.static(mediaDir, {
  fallthrough: true,
  index: false,
  setHeaders(res, filePath) {
    // Informe le navigateur mobile que le serveur gère les plages d'octets (streaming partiel)
    res.setHeader('Accept-Ranges', 'bytes');

    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// Vérifie que le serveur ET la base répondent
app.get('/api/health', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT now() AS now');
    res.json({ status: 'ok', db: 'ok', time: rows[0].now });
  } catch (err) {
    next(err);
  }
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api', require('./routes/catalog.routes'));
app.use('/api/shops', require('./routes/shop.routes'));
app.use('/api/posts', require('./routes/post.routes'));
app.use('/api/media', require('./routes/media.routes'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
