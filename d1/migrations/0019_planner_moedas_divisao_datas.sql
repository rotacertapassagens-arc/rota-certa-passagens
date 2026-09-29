-- Planner: moedas, divisão de custos, compartilhar a viagem, datas reais com lembrete de check-in
-- e voo emitido pela Rota Certa entrando sozinho no roteiro do cliente.
--
-- companions: nomes de quem viaja junto (JSON), usados para dividir os custos. O dono é "Você".
-- share_token: link de leitura da viagem (/viagem/<token>), sem códigos de reserva nem anexos.
ALTER TABLE trips ADD COLUMN companions TEXT;
ALTER TABLE trips ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX idx_trips_share_token ON trips(share_token) WHERE share_token IS NOT NULL;

-- Quem pagou a despesa (nome de um viajante; vazio = "Você"). A moeda já existia (expenses.currency).
ALTER TABLE expenses ADD COLUMN paid_by TEXT;

-- Lembrete de check-in: marca o envio para não repetir. source = 'rota_certa' quando o voo foi
-- lançado pela equipe a partir de uma proposta.
ALTER TABLE itinerary_items ADD COLUMN reminder_sent_at TEXT;
ALTER TABLE itinerary_items ADD COLUMN source TEXT;
CREATE INDEX idx_itinerary_kind_reminder ON itinerary_items(kind, reminder_sent_at);

-- Voo emitido para um e-mail que ainda não tem conta: entra no Planner quando a pessoa entrar.
CREATE TABLE planner_flight_imports (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  lead_id TEXT REFERENCES lead_requests(id) ON DELETE SET NULL,
  payload TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TEXT,
  applied_trip_id TEXT
);
CREATE INDEX idx_flight_imports_email ON planner_flight_imports(email, applied_at);
