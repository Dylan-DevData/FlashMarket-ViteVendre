const { pool, query, withTransaction } = require('../config/db');
const postModel = require('./post.model');

async function findDuplicateSha256(sha256) {
  const { rows } = await query(
    `SELECT id FROM media
     WHERE sha256 = $1 AND status <> 'failed'
     LIMIT 1`,
    [sha256]
  );
  return rows[0] || null;
}

async function findUpload(uploadId, userId, lock = false, client = null) {
  const db = client || { query };
  const { rows } = await db.query(
    `SELECT up.id, up.media_id, up.file_name, up.mime_type, up.total_size, up.chunk_size,
            up.total_chunks, up.received_chunks, up.expected_sha256, up.status,
            m.post_id
     FROM uploads up
     JOIN media m ON m.id = up.media_id
     WHERE up.id = $1 AND up.user_id = $2${lock ? ' FOR UPDATE OF up' : ''}`,
    [uploadId, userId]
  );
  return rows[0] || null;
}

async function createChunkUpload(post, upload) {
  return postModel.createPostWithUpload(post, upload);
}

async function markChunkReceived(upload, chunkIndex) {
  return withTransaction(async (client) => {
    const current = await findUpload(upload.id, upload.userId, true, client);
    if (!current || current.status !== 'in_progress') {
      const error = new Error('Session d’envoi introuvable ou terminée.');
      error.status = 404;
      throw error;
    }
    const { rows } = await client.query(
      `UPDATE uploads
       SET received_chunks = CASE
             WHEN $2 = ANY(received_chunks) THEN received_chunks
             ELSE array_append(received_chunks, $2)
           END,
           updated_at = now()
       WHERE id = $1
       RETURNING received_chunks`,
      [upload.id, chunkIndex]
    );
    return rows[0].received_chunks;
  });
}

async function completeChunkUpload(uploadId, userId, sha256) {
  return withTransaction(async (client) => {
    const upload = await findUpload(uploadId, userId, true, client);
    if (!upload) return null;
    if (upload.status === 'complete') return { ...upload, alreadyComplete: true };
    if (upload.status !== 'in_progress') {
      const error = new Error('Cette session d’envoi est terminée.');
      error.status = 409;
      throw error;
    }
    if (upload.received_chunks.length !== upload.total_chunks) {
      const error = new Error('Des morceaux sont encore manquants.');
      error.status = 409;
      error.missingCount = upload.total_chunks - upload.received_chunks.length;
      throw error;
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sha256]);
    const duplicate = await client.query(
      `SELECT id FROM media WHERE sha256 = $1 AND status <> 'failed' LIMIT 1`,
      [sha256]
    );
    if (duplicate.rowCount) {
      const error = new Error('Cette vidéo a déjà été publiée.');
      error.status = 409;
      throw error;
    }
    await client.query(
      `UPDATE media SET sha256 = $2, status = 'processing'
       WHERE id = $1`,
      [upload.media_id, sha256]
    );
    await client.query(
      `UPDATE uploads SET status = 'complete', updated_at = now() WHERE id = $1`,
      [uploadId]
    );
    return { ...upload, media_id: Number(upload.media_id) };
  });
}

async function listExpiredUploads(maxIdleHours) {
  const { rows } = await query(
    `SELECT id, media_id, file_name FROM uploads
     WHERE status = 'in_progress'
       AND updated_at < now() - ($1 * interval '1 hour')
     LIMIT 200`,
    [maxIdleHours]
  );
  return rows;
}

async function abortExpiredUpload(uploadId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE uploads SET status = 'aborted', updated_at = now()
       WHERE id = $1 AND status = 'in_progress'
       RETURNING media_id`,
      [uploadId]
    );
    if (rows[0]) {
      await client.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [rows[0].media_id]);
      await client.query(
        `UPDATE posts SET status = 'draft' WHERE id = (SELECT post_id FROM media WHERE id = $1) AND status = 'processing'`,
        [rows[0].media_id]
      );
    }
  });
}

async function abortChunkUpload(uploadId, userId) {
  return withTransaction(async (client) => {
    const upload = await findUpload(uploadId, userId, true, client);
    if (!upload) return null;
    if (upload.status === 'in_progress') {
      await client.query(
        `UPDATE uploads SET status = 'aborted', updated_at = now() WHERE id = $1`,
        [uploadId]
      );
      await client.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [upload.media_id]);
      await client.query(
        `UPDATE posts SET status = 'draft' WHERE id = (SELECT post_id FROM media WHERE id = $1) AND status = 'processing'`,
        [upload.media_id]
      );
    } else if (upload.status === 'complete') {
      const error = new Error('Une session terminée ne peut plus être annulée.');
      error.status = 409;
      throw error;
    }
    return upload;
  });
}

async function getForProcessing(mediaId) {
  const { rows } = await query(
    `SELECT m.id, m.post_id, m.kind, m.storage_key, m.sha256
     FROM media m
     JOIN posts p ON p.id = m.post_id
     WHERE m.id = $1 AND m.status = 'processing' AND p.status = 'processing'`,
    [mediaId]
  );
  return rows[0] || null;
}

async function acquireProcessingLock(mediaId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [String(mediaId)]
    );
    if (!rows[0].locked) {
      client.release();
      return null;
    }
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [String(mediaId)]);
      } finally {
        client.release();
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

async function completeAndMaybePublish(mediaId, result) {
  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE media
       SET status = 'ready', storage_key = $2, poster_key = $3,
           width = $4, height = $5, duration_s = $6, phash = $7
       WHERE id = $1 AND status = 'processing'
       RETURNING post_id`,
      [
        mediaId,
        result.storageKey,
        result.posterKey,
        result.width,
        result.height,
        result.duration,
        result.phash === null ? null : result.phash.toString(),
      ]
    );
    if (!updated.rowCount) return null;
    const postId = updated.rows[0].post_id;
    await client.query(
      `UPDATE posts p
       SET status = 'published',
           published_at = now(),
           expires_at = now() + make_interval(days => c.expiry_days)
       FROM categories c
       WHERE p.id = $1
         AND p.category_id = c.id
         AND p.status = 'processing'
         AND EXISTS (SELECT 1 FROM media WHERE post_id = p.id)
         AND NOT EXISTS (
           SELECT 1 FROM media WHERE post_id = p.id AND status <> 'ready'
         )`,
      [postId]
    );
    return postId;
  });
}

async function failProcessing(mediaId) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE media SET status = 'failed'
       WHERE id = $1 AND status = 'processing'
       RETURNING post_id`,
      [mediaId]
    );
    if (result.rowCount) {
      const { rows: abandonedMedia } = await client.query(
        `UPDATE media
         SET status = 'failed'
         WHERE post_id = $1 AND status IN ('processing', 'uploading', 'ready')
         RETURNING id, kind, storage_key`,
        [result.rows[0].post_id]
      );
      await client.query(
        `UPDATE posts SET status = 'draft' WHERE id = $1 AND status = 'processing'`,
        [result.rows[0].post_id]
      );
      return abandonedMedia;
    }
    return [];
  });
}

async function findAccessibleMedia(mediaId, userId) {
  const { rows } = await query(
    `SELECT m.id, m.kind, m.status, m.storage_key, m.poster_key, m.width,
            m.height, m.duration_s, m.position, p.status AS post_status,
            s.owner_id
     FROM media m
     JOIN posts p ON p.id = m.post_id
     JOIN shops s ON s.id = p.shop_id
     WHERE m.id = $1
       AND (p.status = 'published' OR s.owner_id = $2)`,
    [mediaId, userId || null]
  );
  return rows[0] || null;
}

async function recordContact(postId, userId, channel) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT s.owner_id, COALESCE(s.whatsapp, u.phone) AS contact_phone,
              s.whatsapp
       FROM posts p
       JOIN shops s ON s.id = p.shop_id
       JOIN users u ON u.id = s.owner_id
       WHERE p.id = $1 AND p.status = 'published'
         AND (p.expires_at IS NULL OR p.expires_at > now())
         AND s.status = 'active' AND u.status = 'active'
       FOR SHARE OF p, s, u`,
      [postId]
    );
    const post = rows[0];
    if (!post) return { kind: 'not_found' };
    if (Number(post.owner_id) === Number(userId)) return { kind: 'own_post' };
    await client.query(
      `INSERT INTO contact_events (post_id, user_id, channel)
       VALUES ($1, $2, $3)`,
      [postId, userId, channel]
    );
    return {
      kind: 'ok',
      phone: post.contact_phone,
      whatsapp: channel === 'whatsapp' ? (post.whatsapp || post.contact_phone) : null,
    };
  });
}

module.exports = {
  findDuplicateSha256,
  findUpload,
  createChunkUpload,
  markChunkReceived,
  completeChunkUpload,
  listExpiredUploads,
  abortExpiredUpload,
  abortChunkUpload,
  getForProcessing,
  acquireProcessingLock,
  completeAndMaybePublish,
  failProcessing,
  findAccessibleMedia,
  recordContact,
};
