-- ============================================================
-- FlashMarket : schéma PostgreSQL (étape 1)
-- Compatible PostgreSQL 13+ (gen_random_uuid() est intégré)
-- Le script peut être relancé sans erreur (IF NOT EXISTS).
-- ============================================================

-- ---------- Villes ----------
CREATE TABLE IF NOT EXISTS cities (
  id      SERIAL PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  region  TEXT
);

-- ---------- Utilisateurs ----------
-- Un seul type de compte : "user". Un utilisateur devient vendeur
-- dès qu'il possède une boutique (table shops). "admin" sert à la modération.
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  phone           TEXT NOT NULL UNIQUE
                  CHECK (phone ~ '^\+?[0-9]{8,15}$'),
  phone_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  email           TEXT UNIQUE,
  password_hash   TEXT NOT NULL,
  full_name       TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 80),
  avatar_url      TEXT,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  city_id         INTEGER REFERENCES cities(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Boutiques (une seule par utilisateur en V1) ----------
CREATE TABLE IF NOT EXISTS shops (
  id           SERIAL PRIMARY KEY,
  owner_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  slug         TEXT NOT NULL UNIQUE
               CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description  TEXT,
  logo_url     TEXT,
  city_id      INTEGER REFERENCES cities(id) ON DELETE SET NULL,
  whatsapp     TEXT CHECK (whatsapp IS NULL OR whatsapp ~ '^\+?[0-9]{8,15}$'),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Catégories ----------
-- Les règles propres à chaque catégorie sont des DONNÉES, pas du code :
-- durée de vie d'une annonce, gestion de stock, critères autorisés (cases à cocher).
-- Ajouter une catégorie = ajouter une ligne.
CREATE TABLE IF NOT EXISTS categories (
  id                  SERIAL PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  default_price_unit  TEXT NOT NULL DEFAULT 'unit',
  uses_stock          BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_days         INTEGER NOT NULL CHECK (expiry_days > 0),
  allowed_attributes  TEXT[] NOT NULL DEFAULT '{}',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- Annonces ----------
-- Cycle de vie : draft (médias en cours d'envoi) -> processing (FFmpeg / images)
--                -> published -> expired | removed
CREATE TABLE IF NOT EXISTS posts (
  id            BIGSERIAL PRIMARY KEY,
  shop_id       INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description   TEXT,
  price_fcfa    INTEGER NOT NULL CHECK (price_fcfa >= 0),
  price_unit    TEXT NOT NULL DEFAULT 'unit'
                CHECK (price_unit IN ('unit', 'kg', 'bag', 'carton', 'day', 'month')),
  city_id       INTEGER NOT NULL REFERENCES cities(id),
  neighborhood  TEXT,
  stock         INTEGER CHECK (stock IS NULL OR stock >= 0),
  attributes    TEXT[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'processing', 'published', 'expired', 'removed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  sale_price_fcfa INTEGER,
  sale_starts_at TIMESTAMPTZ,
  sale_ends_at  TIMESTAMPTZ,
  CONSTRAINT posts_flash_sale_check CHECK (
    (sale_price_fcfa IS NULL AND sale_starts_at IS NULL AND sale_ends_at IS NULL)
    OR (
      sale_price_fcfa IS NOT NULL
      AND sale_price_fcfa >= 0
      AND sale_price_fcfa < price_fcfa
      AND sale_starts_at IS NOT NULL
      AND sale_ends_at > sale_starts_at
    )
  )
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS sale_price_fcfa INTEGER;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS sale_starts_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS sale_ends_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_flash_sale_check'
      AND conrelid = 'posts'::regclass
  ) THEN
    ALTER TABLE posts ADD CONSTRAINT posts_flash_sale_check CHECK (
      (sale_price_fcfa IS NULL AND sale_starts_at IS NULL AND sale_ends_at IS NULL)
      OR (
        sale_price_fcfa IS NOT NULL
        AND sale_price_fcfa >= 0
        AND sale_price_fcfa < price_fcfa
        AND sale_starts_at IS NOT NULL
        AND sale_ends_at > sale_starts_at
      )
    );
  END IF;
END $$;

-- Flux principal : annonces publiées d'une ville, les plus récentes d'abord
CREATE INDEX IF NOT EXISTS idx_posts_feed
  ON posts (city_id, published_at DESC, id DESC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_posts_category
  ON posts (category_id, published_at DESC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_posts_shop ON posts (shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_expiry ON posts (expires_at) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_posts_flash_sale ON posts (sale_ends_at)
  WHERE status = 'published' AND sale_price_fcfa IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_attributes ON posts USING GIN (attributes);

-- ---------- Médias d'une annonce ----------
-- Règle métier (vérifiée dans le contrôleur) : une annonce contient
-- soit 1 vidéo, soit 1 à 8 photos, jamais un mélange.
CREATE TABLE IF NOT EXISTS media (
  id          BIGSERIAL PRIMARY KEY,
  post_id     BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  position    SMALLINT NOT NULL DEFAULT 0 CHECK (position >= 0),
  status      TEXT NOT NULL DEFAULT 'uploading'
              CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  mime_type   TEXT,
  size_bytes  BIGINT CHECK (size_bytes IS NULL OR size_bytes > 0),
  width       INTEGER,
  height      INTEGER,
  duration_s  NUMERIC(6, 2),
  sha256      CHAR(64),        -- empreinte exacte : intégrité + doublons
  phash       BIGINT,          -- empreinte perceptuelle (plus tard)
  storage_key TEXT,            -- dossier ou fichier de base sur le disque / stockage objet
  poster_key  TEXT,            -- image légère affichée avant la lecture
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, position)
);

CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media (sha256) WHERE sha256 IS NOT NULL;

-- ---------- Envois par morceaux (upload reprenable) ----------
-- Sert à l'étape "chunking d'envoi" : le téléphone envoie le fichier en
-- morceaux ; après une coupure réseau, on demande quels morceaux manquent.
CREATE TABLE IF NOT EXISTS uploads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id         BIGINT REFERENCES media(id) ON DELETE CASCADE,
  file_name        TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  total_size       BIGINT NOT NULL CHECK (total_size > 0),
  chunk_size       INTEGER NOT NULL CHECK (chunk_size > 0),
  total_chunks     INTEGER NOT NULL CHECK (total_chunks > 0),
  received_chunks  INTEGER[] NOT NULL DEFAULT '{}',
  expected_sha256  CHAR(64),
  status           TEXT NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress', 'complete', 'aborted')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads (user_id, status);

-- ---------- Favoris ----------
CREATE TABLE IF NOT EXISTS favorites (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     BIGINT  NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

-- ---------- Signalements ----------
CREATE TABLE IF NOT EXISTS reports (
  id           SERIAL PRIMARY KEY,
  post_id      BIGINT  NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reporter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL
               CHECK (reason IN ('scam', 'wrong_info', 'inappropriate', 'duplicate', 'other')),
  details      TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);

-- ---------- Contacts (appel / WhatsApp) ----------
-- Mesure si l'app résout vraiment le problème : combien de contacts par annonce ?
CREATE TABLE IF NOT EXISTS contact_events (
  id          BIGSERIAL PRIMARY KEY,
  post_id     BIGINT  NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('call', 'whatsapp')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_post ON contact_events (post_id, created_at DESC);
