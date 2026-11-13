const { query } = require('../config/db');

// Accès SQL aux boutiques du propriétaire et aux données publiques de leur vitrine.
async function createShop({ ownerId, name, slug, description, cityId, whatsapp }) {
  const { rows } = await query(
    `INSERT INTO shops (owner_id, name, slug, description, city_id, whatsapp)
     VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT city_id FROM users WHERE id = $1)), $6)
     RETURNING id, owner_id, name, slug, description, city_id, whatsapp, status, created_at`,
    [ownerId, name, slug, description, cityId, whatsapp]
  );
  return rows[0];
}

async function findByOwnerId(ownerId) {
  const { rows } = await query(
    `SELECT id, owner_id, name, slug, description, city_id, whatsapp, status, created_at
     FROM shops
     WHERE owner_id = $1`,
    [ownerId]
  );
  return rows[0] || null;
}

async function findPublicBySlug(slug) {
  const { rows } = await query(
    `SELECT s.id, s.name, s.slug, s.description, s.logo_url, s.city_id, s.whatsapp,
            c.name AS city, u.full_name AS owner_name, u.avatar_url AS owner_avatar_url,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', p.id, 'title', p.title, 'priceFcfa', p.price_fcfa,
                'description', p.description,
                'category', (SELECT cat.name FROM categories cat WHERE cat.id = p.category_id),
                'salePriceFcfa', p.sale_price_fcfa,
                'saleStartsAt', p.sale_starts_at, 'saleEndsAt', p.sale_ends_at,
                'currentPriceFcfa', CASE
                  WHEN p.sale_price_fcfa IS NOT NULL
                    AND now() >= p.sale_starts_at AND now() < p.sale_ends_at
                  THEN p.sale_price_fcfa ELSE p.price_fcfa END,
                'priceUnit', p.price_unit, 'neighborhood', p.neighborhood,
                'publishedAt', p.published_at,
                'media', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'id', m.id, 'type', m.kind, 'position', m.position,
                    'url', '/media/' || m.storage_key,
                    'posterUrl', CASE WHEN m.poster_key IS NULL THEN NULL ELSE '/media/' || m.poster_key END
                  ) ORDER BY m.position)
                  FROM media m WHERE m.post_id = p.id AND m.status = 'ready'
                ), '[]'::jsonb)
              ) ORDER BY p.published_at DESC, p.id DESC)
              FROM posts p
              WHERE p.shop_id = s.id AND p.status = 'published'
                AND (p.expires_at IS NULL OR p.expires_at > now())
            ), '[]'::jsonb) AS posts
     FROM shops s
     JOIN users u ON u.id = s.owner_id
     LEFT JOIN cities c ON c.id = s.city_id
     WHERE s.slug = $1 AND s.status = 'active' AND u.status = 'active'`,
    [slug]
  );
  return rows[0] || null;
}

module.exports = { createShop, findByOwnerId, findPublicBySlug };
