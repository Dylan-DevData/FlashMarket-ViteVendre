const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { verifyMediaSignature } = require('./post.controller');

test('le contrôle de signature refuse un faux type de média', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flashmarket-signature-'));
  const filePath = path.join(directory, 'wrong.jpg');
  await fs.writeFile(filePath, Buffer.from('not an image'));

  try {
    await assert.rejects(
      verifyMediaSignature(filePath, 'image/jpeg'),
      (error) => error.status === 415
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('le contrôle de signature reconnaît les principaux formats acceptés', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flashmarket-signature-'));
  const fixture = async (name, header) => {
    const filePath = path.join(directory, name);
    await fs.writeFile(filePath, header);
    return filePath;
  };
  const jpeg = await fixture('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const mp4Header = Buffer.alloc(12);
  mp4Header.write('ftyp', 4, 'ascii');
  const mp4 = await fixture('video.mp4', mp4Header);
  const webm = await fixture('video.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

  try {
    await verifyMediaSignature(jpeg, 'image/jpeg');
    await verifyMediaSignature(mp4, 'video/mp4');
    await verifyMediaSignature(webm, 'video/webm');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
