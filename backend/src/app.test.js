const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./app');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
}));

test('le feed demande une localité valide', async () => {
  const response = await fetch(`${baseUrl}/api/posts`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /city_id/);
});

test('une publication exige un JWT avant d’accepter les fichiers', async () => {
  const response = await fetch(`${baseUrl}/api/posts`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('un upload vidéo exige un JWT', async () => {
  const response = await fetch(`${baseUrl}/api/media/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);
});

test('une session d’upload ne peut pas être consultée anonymement', async () => {
  const response = await fetch(`${baseUrl}/api/media/uploads/not-a-uuid`);
  assert.equal(response.status, 401);
});

test('FFmpeg est configuré avec -movflags +faststart pour déplacer le moov atom au début', () => {
  const fs = require('fs');
  const path = require('path');
  const serviceCode = fs.readFileSync(path.join(__dirname, 'services', 'ffmpeg.service.js'), 'utf8');
  assert.ok(
    serviceCode.includes('-movflags +faststart'),
    'L’argument -movflags +faststart doit être présent dans le service FFmpeg pour le streaming direct rapide'
  );
});
