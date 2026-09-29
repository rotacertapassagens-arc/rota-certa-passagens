-- Planner: código e link da reserva em cada item do roteiro, e anexos (PDF ou foto) por item.
-- Os arquivos ficam no próprio D1 em base64, como as fotos do blog (o R2 exige cartão).
-- Limites aplicados no Worker: 1,4 MB por arquivo, 5 por item, 20 MB por conta e 150 MB no total,
-- para o banco (500 MB no plano grátis) nunca encher. A coluna data fica por último de propósito:
-- somar size não precisa ler o arquivo inteiro.
ALTER TABLE itinerary_items ADD COLUMN booking_code TEXT;
ALTER TABLE itinerary_items ADD COLUMN booking_url TEXT;

CREATE TABLE planner_attachments (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES itinerary_items(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size INTEGER NOT NULL CHECK (size > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data TEXT NOT NULL
);
CREATE INDEX idx_planner_attachments_trip ON planner_attachments(owner_user_id, trip_id);
CREATE INDEX idx_planner_attachments_item ON planner_attachments(item_id);
CREATE INDEX idx_planner_attachments_size ON planner_attachments(owner_user_id, size);
