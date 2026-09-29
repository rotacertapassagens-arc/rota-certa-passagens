-- Guias de viagem (blog) editáveis no painel admin: regiões, posts e fotos.
-- As fotos chegam já reduzidas pelo navegador (1600 px e 900 px) e ficam em base64 no D1, sem
-- depender de outro produto da Cloudflare. Cada variação cabe folgada no limite de 2 MB por linha.

CREATE TABLE blog_regions (
  id TEXT PRIMARY KEY,                -- vira o filtro /blog/#<id>
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE blog_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  region_id TEXT NOT NULL REFERENCES blog_regions(id),
  title TEXT NOT NULL,
  title_highlight TEXT,               -- trecho do título em dourado itálico (opcional)
  summary TEXT NOT NULL,              -- cartões, Google e compartilhamento
  lede TEXT,                          -- frase abaixo do título (opcional; senão usa o resumo)
  destination TEXT,                   -- vai preenchido no botão de proposta de voo
  cta_title TEXT,                     -- chamada final personalizada (opcional)
  cover_url TEXT,
  cover_url_small TEXT,
  cover_alt TEXT,
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  body TEXT NOT NULL DEFAULT '[]',    -- JSON com os blocos do texto
  reading_minutes INTEGER NOT NULL DEFAULT 5,
  published_at TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX blog_posts_status_idx ON blog_posts(status, published_at DESC);

CREATE TABLE blog_media (
  id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('g', 'm')),   -- g = grande (até 1600 px), m = média (até 900 px)
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/webp', 'image/png')),
  data TEXT NOT NULL,                 -- base64
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, variant)
);

INSERT INTO blog_regions (id, name, sort_order) VALUES
  ('brasil', 'Brasil', 1),
  ('portugal', 'Portugal', 2),
  ('europa', 'Europa', 3);
