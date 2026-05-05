-- ══════════════════════════════════════════════════════════════
-- AXION — Schema D1 (Cloudflare SQLite)
-- Padrão: blob de estado + tabela de usuários separada para auth
-- ══════════════════════════════════════════════════════════════

-- Usuários (membros da equipe) — fonte de verdade da autenticação
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,           -- ex: 'dir', 'at_x9z3k', etc
  login       TEXT UNIQUE NOT NULL,       -- username (case-insensitive na lookup)
  pwd_hash    TEXT NOT NULL,              -- SHA-256 hex
  name        TEXT NOT NULL,
  abbr        TEXT,                       -- iniciais avatar
  role        TEXT NOT NULL,              -- diretor|socio|produtor|atendente|afiliado|cobrador|gestor
  color       TEXT,                       -- hex de avatar
  bg          TEXT,                       -- bg rgba do avatar
  com_pct     REAL DEFAULT 0,             -- comissão padrão %
  created_at  INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_login ON users(login);

-- Sessões ativas (token → user_id)
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,           -- random hex 64 chars
  user_id     TEXT NOT NULL,
  created_at  INTEGER DEFAULT (strftime('%s','now')),
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Estado da Dashboard (1 linha singleton, blob JSON com tudo)
-- Contém: leads, vendas, gastos, chips, produtos, kb_cols, tags, payt_mapping, acl, etc.
-- Não inclui users/sessions (esses ficam em tabelas próprias por motivo de segurança).
CREATE TABLE IF NOT EXISTS dashboard_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- só 1 linha possível
  data        TEXT NOT NULL,                       -- JSON do DB
  updated_at  INTEGER DEFAULT (strftime('%s','now')),
  updated_by  TEXT,                                -- user_id que fez último write
  version     INTEGER DEFAULT 1                    -- contador de mudanças (otimistic concurrency)
);

-- Bootstrap: linha de estado vazia
INSERT OR IGNORE INTO dashboard_state (id, data, version) VALUES (1, '{}', 0);
