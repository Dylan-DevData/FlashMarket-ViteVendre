const app = require('./app');
const { port, requestTimeoutMs, headersTimeoutMs } = require('./config/env');
const { pool } = require('./config/db');
const mediaQueue = require('./services/media-queue.service');

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`API FlashMarket en écoute sur http://0.0.0.0:${port}`);
  mediaQueue.recoverPending().catch((error) => {
    console.error('[media] récupération des traitements interrompue :', error.message);
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(headersTimeoutMs, requestTimeoutMs);
});

// Arrêt propre (Ctrl+C) : on ferme le serveur puis la connexion à la base
function shutdown() {
  console.log('Arrêt en cours…');
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
