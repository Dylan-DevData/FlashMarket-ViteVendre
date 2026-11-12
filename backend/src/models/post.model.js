const { query, withTransaction } = require('../config/db');

async function insertPost(client, post) {
  const shopResult = await client.query(
    `SELECT s.id
     FROM shops s
     JOIN users u ON u.id = s.owner_id
     WHERE s.owner_id = $1 AND s.status = 'active' AND u.status = 'active'
     FOR SHARE`,
    [post.ownerId]
  );
  if (!shopResult.rowCount) {
    const error = new Error('Créez une boutique active avant de publier une annonce.');
    error.status = 403;
    throw error;
  }
  const { rows } = await client.query(
    `INSERT INTO posts
      (shop_id, category_id, title, description, price_fcfa, price_unit,
       city_id, neighborhood, stock, attributes, sale_price_fcfa, sale_starts_at,
       sale_ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'processing')
     RETURNING id`,
    [
      shopResult.rows[0].id,
      post.categoryId,
      post.title,
      post.description,
      post.priceFcfa,
      post.priceUnit,
      post.cityId,
      post.neighborhood,
      post.stock,
      post.attributes,
      post.salePriceFcfa,
      post.saleStartsAt,
      post.saleEndsAt,
    ]
  );
  return Number(rows[0].id);
}

async function createPostWithMedia(post, mediaItems) {
  return withTransaction(async (client) => {
    const postId = await insertPost(client, post);
    const mediaIds = [];
    for (const media of mediaItems) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [media.sha256]);
      const duplicate = await client.query(
        `SELECT id FROM media WHERE sha256 = $1 AND status <> 'failed' LIMIT 1`,
        [media.sha256]
      );
      if (duplicate.rowCount) {
        const error = new Error('Ce média a déjà été publié.');
        error.status = 409;
        throw error;
      }
      const result = await client.query(
        `INSERT INTO media
          (post_id, kind, position, status, mime_type, size_bytes, sha256, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          postId,
          media.kind,
          media.position,
          media.initialStatus || 'processing',
          media.mimeType,
          media.sizeBytes,
          media.sha256,
          `upload:${media.filename}`,
        ]
      );
      mediaIds.push(Number(result.rows[0].id));
    }
    return { id: postId, mediaIds };
  });
}

async function createPostWithUpload(post, upload) {
  return withTransaction(async (client) => {
    const postId = await insertPost(client, post);
    const mediaResult = await client.query(
      `INSERT INTO media (post_id, kind, position, status, mime_type, size_bytes, storage_key)
       VALUES ($1, 'video', 0, 'uploading', $2, $3, $4)
       RETURNING id`,
      [postId, upload.mimeType, upload.totalSize, `upload:${upload.fileName}`]
    );
    const mediaId = Number(mediaResult.rows[0].id);
    const uploadResult = await client.query(
      `INSERT INTO uploads
        (user_id, media_id, file_name, mime_type, total_size, chunk_size,
         total_chunks, expected_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        post.ownerId,
        mediaId,
        upload.fileName,
        upload.mimeType,
        upload.totalSize,
        upload.chunkSize,
        upload.totalChunks,
        upload.expectedSha256,
      ]
    );
    return { id: postId, mediaId, uploadId: uploadResult.rows[0].id };
  });
}

async function findCategory(categoryId) {
  const { rows } = await query(
    `SELECT id, expiry_days, default_price_unit, uses_stock, allowed_attributes
     FROM categories
     WHERE id = $1 AND is_active = TRUE`,
    [categoryId]
  );
  return rows[0] || null;
}

async function getFeed({ cityId, categoryId, search, limit, offset }) {
  const values = [];
  const filters = [`p.status = 'published'`, `(p.expires_at IS NULL OR p.expires_at > now())`];
  if (cityId !== null) {
    values.push(cityId);
    filters.push(`p.city_id = $${values.length}`);
  }
  if (categoryId !== null) {
    values.push(categoryId);
    filters.push(`p.category_id = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    filters.push(`(p.title ILIKE $${values.length} OR p.description ILIKE $${values.length} OR p.neighborhood ILIKE $${values.length})`);
  }
  values.push(limit, offset);

  const { rows } = await query(
    `SELECT p.id, p.title, p.description, p.price_fcfa, p.price_unit,
            p.sale_price_fcfa, p.sale_starts_at, p.sale_ends_at,
            CASE WHEN p.sale_price_fcfa IS NOT NULL
                       AND now() >= p.sale_starts_at AND now() < p.sale_ends_at
                 THEN p.sale_price_fcfa ELSE p.price_fcfa END AS current_price_fcfa,
            (p.sale_price_fcfa IS NOT NULL
               AND now() >= p.sale_starts_at AND now() < p.sale_ends_at) AS flash_sale_active,
            p.city_id, c.name AS city, p.neighborhood, p.stock, p.attributes,
            p.category_id, cat.name AS category, p.published_at, p.expires_at,
            jsonb_build_object(
              'id', s.id, 'name', s.name, 'slug', s.slug, 'logoUrl', s.logo_url,
              'ownerName', u.full_name, 'ownerAvatarUrl', u.avatar_url
            ) AS shop,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', m.id, 'type', m.kind, 'position', m.position,
                'url', '/media/' || m.storage_key,
                'posterUrl', CASE WHEN m.poster_key IS NULL THEN NULL ELSE '/media/' || m.poster_key END,
                'width', m.width, 'height', m.height, 'durationSeconds', m.duration_s
              ) ORDER BY m.position)
              FROM media m
              WHERE m.post_id = p.id AND m.status = 'ready'
            ), '[]'::jsonb) AS media
     FROM posts p
     JOIN cities c ON c.id = p.city_id
     JOIN categories cat ON cat.id = p.category_id
     JOIN shops s ON s.id = p.shop_id
     JOIN users u ON u.id = s.owner_id
     WHERE ${filters.join(' AND ')}
     ORDER BY p.published_at DESC, p.id DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return rows;
}

async function getPendingMedia(afterId = 0) {
  const { rows } = await query(
    `SELECT m.id, m.kind, m.storage_key, p.id AS post_id
     FROM media m
     JOIN posts p ON p.id = m.post_id
     WHERE m.status = 'processing'
       AND p.status = 'processing'
       AND m.storage_key LIKE 'upload:%'
       AND m.id > $1
     ORDER BY m.id
     LIMIT 100`,
    [afterId]
  );
  return rows;
}

async function getPostForViewer(postId, userId) {
  const { rows } = await query(
    `SELECT p.id, p.title, p.description, p.price_fcfa, p.price_unit,
            p.sale_price_fcfa, p.sale_starts_at, p.sale_ends_at,
            CASE WHEN p.sale_price_fcfa IS NOT NULL
                       AND now() >= p.sale_starts_at AND now() < p.sale_ends_at
                 THEN p.sale_price_fcfa ELSE p.price_fcfa END AS current_price_fcfa,
            (p.sale_price_fcfa IS NOT NULL
               AND now() >= p.sale_starts_at AND now() < p.sale_ends_at) AS flash_sale_active,
            p.city_id, c.name AS city, p.neighborhood, p.stock, p.attributes,
            p.category_id, cat.name AS category, p.status, p.published_at, p.expires_at,
            jsonb_build_object(
              'id', s.id, 'name', s.name, 'slug', s.slug, 'logoUrl', s.logo_url,
              'ownerName', u.full_name, 'ownerAvatarUrl', u.avatar_url
            ) AS shop,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', m.id, 'type', m.kind, 'position', m.position, 'status', m.status,
                'url', CASE WHEN m.status = 'ready' THEN '/media/' || m.storage_key ELSE NULL END,
                'posterUrl', CASE WHEN m.poster_key IS NULL THEN NULL ELSE '/media/' || m.poster_key END,
                'width', m.width, 'height', m.height, 'durationSeconds', m.duration_s
              ) ORDER BY m.position)
              FROM media m WHERE m.post_id = p.id
            ), '[]'::jsonb) AS media
     FROM posts p
     JOIN cities c ON c.id = p.city_id
     JOIN categories cat ON cat.id = p.category_id
     JOIN shops s ON s.id = p.shop_id
     JOIN users u ON u.id = s.owner_id
     WHERE p.id = $1
       AND (p.status = 'published' OR s.owner_id = $2)
       AND (p.status <> 'published' OR p.expires_at IS NULL OR p.expires_at > now())`,
    [postId, userId]
  );
  return rows[0] || null;
}

async function cityExists(cityId) {
  const { rows } = await query('SELECT 1 FROM cities WHERE id = $1', [cityId]);
  return rows.length > 0;
}

module.exports = {
  createPostWithMedia,
  createPostWithUpload,
  findCategory,
  getFeed,
  getPostForViewer,
  getPendingMedia,
  cityExists,
};
