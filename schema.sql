-- ═══════════════════════════════════════════════════════════════════
-- AXION CRM v2 — SCHEMA
-- PostgreSQL 14+ (SQLite-compatível com pequenos ajustes)
-- ═══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── ENUMS ────────────────────────────────────────────────────────
CREATE TYPE user_role AS ENUM (
  'diretor','produtor','afiliado','atendente','recuperador','gestor_trafego'
);

CREATE TYPE lead_status AS ENUM (
  'A Enviar','Enviado','Cobrança','Retirada','Pago',
  'Frustrado','Devolvido','Cancelado','Atenção'
);

CREATE TYPE modalidade_t AS ENUM ('antecipado','entrega');

CREATE TYPE chip_status AS ENUM (
  'aquecimento','ativo','banido','reserva','recarga_pendente'
);

CREATE TYPE webhook_origem AS ENUM (
  'Hotmart','Kiwify','Eduzz','PerfectPay','Braip','Correios','Custom'
);

-- ─── USERS / EQUIPE ───────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  role          user_role NOT NULL,
  abbr          TEXT,
  color         TEXT,
  comissao_pct  NUMERIC(5,2) DEFAULT 8.00,
  ativo         BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ─── PRODUTOS ─────────────────────────────────────────────────────
CREATE TABLE produtos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome          TEXT NOT NULL,
  preco_padrao  NUMERIC(10,2),
  custo_padrao  NUMERIC(10,2),
  comissao_pct  NUMERIC(5,2) DEFAULT 8.00,
  produtor_id   UUID REFERENCES users(id),
  ativo         BOOLEAN DEFAULT TRUE
);

-- ─── TAGS (multi-uso: leads, chips) ───────────────────────────────
CREATE TABLE tags (
  id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome  TEXT UNIQUE NOT NULL,
  cor   TEXT,
  scope TEXT CHECK (scope IN ('lead','chip','ambos')) DEFAULT 'ambos'
);

-- ─── LEADS (CRM) ──────────────────────────────────────────────────
CREATE TABLE leads (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- identificação
  nome              TEXT NOT NULL,
  cpf               TEXT,
  whatsapp          TEXT NOT NULL,
  email             TEXT,
  -- endereço
  cep               TEXT,
  endereco          TEXT,
  numero            TEXT,
  complemento       TEXT,
  bairro            TEXT,
  cidade            TEXT,
  estado            CHAR(2),
  -- origem
  origem            TEXT,
  campanha          TEXT,
  utm_source        TEXT,
  utm_medium        TEXT,
  -- pedido
  produto_id        UUID REFERENCES produtos(id),
  produto_nome      TEXT,
  tratamento        TEXT,
  valor             NUMERIC(10,2),
  custo_fornec      NUMERIC(10,2),
  comissao_pct      NUMERIC(5,2),
  modalidade        modalidade_t DEFAULT 'antecipado',
  metodo_pgto       TEXT,
  status_pgto       TEXT,
  link_checkout     TEXT,
  codigo_rastreio   TEXT,
  -- pipeline
  status_funil      lead_status NOT NULL DEFAULT 'A Enviar',
  agendamento_em    TIMESTAMPTZ,
  -- atribuição
  atendente_id      UUID REFERENCES users(id),
  produtor_id       UUID REFERENCES users(id),
  afiliado_id       UUID REFERENCES users(id),
  -- rastreamento operacional
  ultimo_evento_correios TEXT,
  ultimo_evento_em       TIMESTAMPTZ,
  cidade_destino_atingida BOOLEAN DEFAULT FALSE,
  follow_up_flag    TEXT,           -- 'cidade_destino','sem_atualizacao_72h','agendamento_vencido'
  observacoes       TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX leads_status_idx        ON leads(status_funil);
CREATE INDEX leads_atendente_idx     ON leads(atendente_id);
CREATE INDEX leads_modalidade_idx    ON leads(modalidade);
CREATE INDEX leads_agendamento_idx   ON leads(agendamento_em) WHERE agendamento_em IS NOT NULL;
CREATE INDEX leads_followup_idx      ON leads(follow_up_flag) WHERE follow_up_flag IS NOT NULL;
CREATE INDEX leads_created_idx       ON leads(created_at);

-- ─── LEAD ↔ TAGS ──────────────────────────────────────────────────
CREATE TABLE lead_tags (
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  tag_id  UUID REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);

-- ─── HISTÓRICO de etapa ───────────────────────────────────────────
CREATE TABLE lead_status_log (
  id          BIGSERIAL PRIMARY KEY,
  lead_id     UUID REFERENCES leads(id) ON DELETE CASCADE,
  status_de   lead_status,
  status_para lead_status,
  user_id     UUID REFERENCES users(id),
  origem      TEXT DEFAULT 'manual',  -- manual | webhook | automacao
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── COMENTÁRIOS no lead ──────────────────────────────────────────
CREATE TABLE lead_comentarios (
  id         BIGSERIAL PRIMARY KEY,
  lead_id    UUID REFERENCES leads(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id),
  texto      TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── VENDAS (gerada quando lead → 'Pago') ─────────────────────────
CREATE TABLE vendas (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id                     UUID REFERENCES leads(id),
  produto_nome                TEXT,
  valor_bruto                 NUMERIC(10,2) NOT NULL,
  custo_fornec                NUMERIC(10,2) DEFAULT 0,
  comissao_valor              NUMERIC(10,2) DEFAULT 0,
  taxa_gateway                NUMERIC(10,2) DEFAULT 0,
  -- visão afiliado (PRIORITÁRIA na UI)
  receita_bruta_afiliado      NUMERIC(10,2),  -- = comissao_valor
  receita_liquida_afiliado    NUMERIC(10,2),  -- = comissao_valor - taxa_gateway_proporcional
  -- visão produtor
  lucro_produtor              NUMERIC(10,2),
  atendente_id                UUID REFERENCES users(id),
  afiliado_id                 UUID REFERENCES users(id),
  produtor_id                 UUID REFERENCES users(id),
  data_venda                  TIMESTAMPTZ DEFAULT now(),
  status_log                  TEXT  -- Comprado | Enviado | Entregue
);

CREATE INDEX vendas_data_idx     ON vendas(data_venda);
CREATE INDEX vendas_afiliado_idx ON vendas(afiliado_id);

-- ─── CONTINGÊNCIA / CHIPS WHATSAPP ────────────────────────────────
CREATE TABLE chips (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  numero          TEXT UNIQUE NOT NULL,
  atendente_id    UUID REFERENCES users(id),
  modelo_celular  TEXT,                    -- "iPhone 13", "Samsung A54", etc.
  imei            TEXT,
  status          chip_status DEFAULT 'aquecimento',
  dia_aquecimento INT CHECK (dia_aquecimento BETWEEN 0 AND 7),
  data_inicio     DATE,
  ultima_recarga  DATE,
  proxima_recarga DATE GENERATED ALWAYS AS (ultima_recarga + INTERVAL '90 days') STORED,
  valor_recarga   NUMERIC(8,2),
  operadora       TEXT,
  anotacoes       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX chips_proxima_idx ON chips(proxima_recarga);

-- chip ↔ tags (status visual: "spam-free", "convertendo bem", "queimado", etc.)
CREATE TABLE chip_tags (
  chip_id UUID REFERENCES chips(id) ON DELETE CASCADE,
  tag_id  UUID REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (chip_id, tag_id)
);

-- histórico de recargas (para auditoria + alerta dos 3 meses)
CREATE TABLE chip_recargas (
  id           BIGSERIAL PRIMARY KEY,
  chip_id      UUID REFERENCES chips(id) ON DELETE CASCADE,
  valor        NUMERIC(8,2),
  data_recarga DATE NOT NULL,
  user_id      UUID REFERENCES users(id),
  observacoes  TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- tarefas do checklist de aquecimento
CREATE TABLE chip_tasks (
  chip_id    UUID REFERENCES chips(id) ON DELETE CASCADE,
  dia        INT NOT NULL,
  task_index INT NOT NULL,
  done       BOOLEAN DEFAULT FALSE,
  done_at    TIMESTAMPTZ,
  PRIMARY KEY (chip_id, dia, task_index)
);

-- ─── INVESTIMENTOS DA EMPRESA (entram no DRE) ─────────────────────
CREATE TABLE investimentos (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  categoria   TEXT CHECK (categoria IN
              ('hardware','software','ferramenta','curso',
               'marketing','infra','equipe','outros')),
  descricao   TEXT NOT NULL,
  valor       NUMERIC(10,2) NOT NULL,
  data        DATE NOT NULL,
  responsavel UUID REFERENCES users(id),
  recorrente  BOOLEAN DEFAULT FALSE,
  observacoes TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── GASTOS DE TRÁFEGO ────────────────────────────────────────────
CREATE TABLE gastos_trafego (
  id            BIGSERIAL PRIMARY KEY,
  data          DATE NOT NULL,
  plataforma    TEXT,                       -- Meta | TikTok | Google | YouTube
  campanha      TEXT,
  valor         NUMERIC(10,2),
  leads_gerados INT,
  user_id       UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ─── MAPEAMENTO PAYT (evento → ação no CRM) ──────────────────────
CREATE TABLE payt_mapping (
  evento     TEXT PRIMARY KEY,  -- ex: 'finalizada', 'aguardando_pagamento'
  etapa      TEXT,              -- coluna do CRM destino
  spg        TEXT,              -- status_pgto a aplicar
  action     TEXT NOT NULL DEFAULT 'mover'
             CHECK (action IN ('mover','pagar','tag','rastreio','criar_lead')),
  tag        TEXT,              -- tag a adicionar quando action='tag'
  ativo      BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Defaults — usuário pode customizar via UI
INSERT INTO payt_mapping (evento, etapa, spg, action, tag) VALUES
  ('aguardando_pagamento',   'A Enviar',  'Pendente','mover',  NULL),
  ('finalizada',              'Pago',     'Pago',    'pagar',  NULL),
  ('faturada',                'Pago',     'Pago',    'pagar',  NULL),
  ('cancelada',               'Cancelado','Recusado','mover',  NULL),
  ('cancelada_chargeback',    'Frustrado','Recusado','tag',    'chargeback'),
  ('cancelada_reembolsada',   'Devolvido','Recusado','mover',  NULL),
  ('abandono_checkout',       'Cobrança', 'Pendente','criar_lead','recuperar'),
  ('entrega_atualizada',       NULL,       NULL,     'rastreio',NULL),
  ('solicitacao_reembolso',   'Atenção',   NULL,     'tag',    'reembolso-solicitado'),
  ('pagamento_expirado',      'Frustrado','Recusado','mover',  NULL),
  ('aguardando_confirmacao',  'Cobrança', 'Pendente','mover',  NULL),
  ('pedido_confirmado',       'Pago',     'Pago',    'pagar',  NULL),
  ('pedido_frustrado',        'Frustrado','Recusado','mover',  NULL);

-- ─── WEBHOOKS RECEBIDOS (audit log + retry) ───────────────────────
CREATE TABLE webhooks_log (
  id          BIGSERIAL PRIMARY KEY,
  origem      webhook_origem,
  evento      TEXT,                         -- pedido.aprovado | pedido.cancelado | rastreio.entregue ...
  payload     JSONB,
  lead_id     UUID REFERENCES leads(id),
  status_de   lead_status,
  status_para lead_status,
  processado  BOOLEAN DEFAULT FALSE,
  erro        TEXT,
  recebido_em TIMESTAMPTZ DEFAULT now(),
  processado_em TIMESTAMPTZ
);

CREATE INDEX webhooks_pendentes_idx ON webhooks_log(processado) WHERE processado = FALSE;

-- ─── FOLLOW-UPS (alertas visuais) ─────────────────────────────────
CREATE TABLE follow_ups (
  id           BIGSERIAL PRIMARY KEY,
  lead_id      UUID REFERENCES leads(id) ON DELETE CASCADE,
  tipo         TEXT CHECK (tipo IN
               ('cidade_destino','sem_atualizacao_72h',
                'agendamento_vencido','agendamento_hoje')),
  mensagem     TEXT,
  agendado_em  TIMESTAMPTZ,
  resolvido    BOOLEAN DEFAULT FALSE,
  resolvido_em TIMESTAMPTZ,
  user_id      UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX followups_pendentes_idx ON follow_ups(resolvido) WHERE resolvido = FALSE;

-- ═══════════════════════════════════════════════════════════════════
-- VIEWS (alimentam dashboards)
-- ═══════════════════════════════════════════════════════════════════

-- "Valor Total na Mesa" — dashboard do Recuperador (COD pendente)
CREATE VIEW v_valor_na_mesa AS
SELECT
  l.atendente_id,
  COUNT(*)                                      AS qtd_pedidos,
  COALESCE(SUM(l.valor),0)                      AS total_mesa,
  COALESCE(SUM(l.valor) FILTER
    (WHERE now() - l.updated_at > INTERVAL '7 days'),0) AS aging_critico
FROM leads l
WHERE l.modalidade   = 'entrega'
  AND l.status_funil IN ('Enviado','Retirada','Cobrança')
  AND COALESCE(l.status_pgto,'') <> 'Pago'
GROUP BY l.atendente_id;

-- DRE mensal consolidado
CREATE VIEW v_dre_mensal AS
SELECT
  date_trunc('month', d.dia)::date         AS mes,
  COALESCE(v.receita_bruta,0)              AS receita_bruta,
  COALESCE(v.custo_fornec,0)               AS custo_fornec,
  COALESCE(v.comissoes,0)                  AS comissoes,
  COALESCE(v.taxas,0)                      AS taxas,
  COALESCE(t.gasto_trafego,0)              AS gasto_trafego,
  COALESCE(i.investimentos,0)              AS investimentos,
  COALESCE(v.receita_bruta,0)
    - COALESCE(v.custo_fornec,0)
    - COALESCE(v.comissoes,0)
    - COALESCE(v.taxas,0)
    - COALESCE(t.gasto_trafego,0)
    - COALESCE(i.investimentos,0)          AS lucro_liquido,
  -- ROAS = receita / gasto em mídia
  CASE WHEN COALESCE(t.gasto_trafego,0) > 0
       THEN ROUND(COALESCE(v.receita_bruta,0) / t.gasto_trafego, 2)
       ELSE NULL END                       AS roas
FROM (SELECT generate_series(date_trunc('month', now()) - INTERVAL '11 months',
                              date_trunc('month', now()),
                              INTERVAL '1 month') AS dia) d
LEFT JOIN (
  SELECT date_trunc('month', data_venda)::date AS mes,
         SUM(valor_bruto)    AS receita_bruta,
         SUM(custo_fornec)   AS custo_fornec,
         SUM(comissao_valor) AS comissoes,
         SUM(taxa_gateway)   AS taxas
  FROM vendas GROUP BY 1
) v ON v.mes = d.dia::date
LEFT JOIN (
  SELECT date_trunc('month', data)::date AS mes, SUM(valor) AS gasto_trafego
  FROM gastos_trafego GROUP BY 1
) t ON t.mes = d.dia::date
LEFT JOIN (
  SELECT date_trunc('month', data)::date AS mes, SUM(valor) AS investimentos
  FROM investimentos GROUP BY 1
) i ON i.mes = d.dia::date;

-- Alertas de recarga (chips com proxima_recarga ≤ hoje + 7d)
CREATE VIEW v_chips_recarga_pendente AS
SELECT c.*,
       (c.proxima_recarga - CURRENT_DATE) AS dias_para_recarga
FROM chips c
WHERE c.proxima_recarga <= CURRENT_DATE + INTERVAL '7 days'
ORDER BY c.proxima_recarga ASC;

-- ═══════════════════════════════════════════════════════════════════
-- TRIGGERS
-- ═══════════════════════════════════════════════════════════════════

-- 1) Quando lead muda de etapa → log + se virar 'Pago' cria venda
CREATE OR REPLACE FUNCTION trg_lead_status_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status_funil IS DISTINCT FROM OLD.status_funil THEN
    INSERT INTO lead_status_log(lead_id, status_de, status_para, user_id)
      VALUES (NEW.id, OLD.status_funil, NEW.status_funil, NEW.atendente_id);

    IF NEW.status_funil = 'Pago' AND OLD.status_funil <> 'Pago' THEN
      INSERT INTO vendas(
        lead_id, produto_nome, valor_bruto, custo_fornec,
        comissao_valor, receita_bruta_afiliado,
        receita_liquida_afiliado, lucro_produtor,
        atendente_id, afiliado_id, produtor_id, data_venda, status_log
      ) VALUES (
        NEW.id, NEW.produto_nome, COALESCE(NEW.valor,0),
        COALESCE(NEW.custo_fornec,0),
        COALESCE(NEW.valor,0) * COALESCE(NEW.comissao_pct,0)/100,
        COALESCE(NEW.valor,0) * COALESCE(NEW.comissao_pct,0)/100,
        COALESCE(NEW.valor,0) * COALESCE(NEW.comissao_pct,0)/100 * 0.97,
        COALESCE(NEW.valor,0) - COALESCE(NEW.custo_fornec,0)
          - COALESCE(NEW.valor,0) * COALESCE(NEW.comissao_pct,0)/100,
        NEW.atendente_id, NEW.afiliado_id, NEW.produtor_id,
        now(), 'Comprado'
      );
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER lead_status_change
  BEFORE UPDATE OF status_funil ON leads
  FOR EACH ROW EXECUTE FUNCTION trg_lead_status_change();

-- 2) Quando recebe webhook → atualiza lead e marca processado
CREATE OR REPLACE FUNCTION processa_webhook(_webhook_id BIGINT) RETURNS VOID AS $$
DECLARE w webhooks_log%ROWTYPE;
BEGIN
  SELECT * INTO w FROM webhooks_log WHERE id = _webhook_id AND processado = FALSE;
  IF NOT FOUND THEN RETURN; END IF;

  IF w.evento = 'pedido.aprovado' AND w.lead_id IS NOT NULL THEN
    UPDATE leads SET status_funil='Pago', status_pgto='Pago' WHERE id = w.lead_id;
  ELSIF w.evento = 'pedido.cancelado' AND w.lead_id IS NOT NULL THEN
    UPDATE leads SET status_funil='Cancelado' WHERE id = w.lead_id;
  ELSIF w.evento = 'rastreio.cidade_destino' AND w.lead_id IS NOT NULL THEN
    UPDATE leads SET cidade_destino_atingida=TRUE, follow_up_flag='cidade_destino' WHERE id = w.lead_id;
    INSERT INTO follow_ups(lead_id, tipo, mensagem)
      VALUES (w.lead_id, 'cidade_destino', 'Pedido chegou na cidade — confirmar com cliente');
  ELSIF w.evento = 'rastreio.entregue' AND w.lead_id IS NOT NULL THEN
    UPDATE leads SET status_funil='Retirada' WHERE id = w.lead_id AND status_funil <> 'Pago';
  END IF;

  UPDATE webhooks_log SET processado=TRUE, processado_em=now() WHERE id=_webhook_id;
END $$ LANGUAGE plpgsql;

-- 3) Job diário: gera follow-ups por inatividade > 72h
CREATE OR REPLACE FUNCTION gera_followups_inatividade() RETURNS VOID AS $$
BEGIN
  INSERT INTO follow_ups(lead_id, tipo, mensagem)
  SELECT id, 'sem_atualizacao_72h',
         'Sem atualização nos Correios há mais de 72h'
  FROM leads
  WHERE status_funil IN ('Enviado','Retirada')
    AND ultimo_evento_em < now() - INTERVAL '72 hours'
    AND NOT EXISTS (
      SELECT 1 FROM follow_ups f
      WHERE f.lead_id = leads.id
        AND f.tipo = 'sem_atualizacao_72h'
        AND f.resolvido = FALSE
    );

  UPDATE leads SET follow_up_flag = 'sem_atualizacao_72h'
  WHERE id IN (SELECT lead_id FROM follow_ups
               WHERE tipo='sem_atualizacao_72h' AND resolvido=FALSE);
END $$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (papéis)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE leads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE chips          ENABLE ROW LEVEL SECURITY;
ALTER TABLE investimentos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE gastos_trafego ENABLE ROW LEVEL SECURITY;

-- Diretor / Produtor: vê tudo
CREATE POLICY p_diretor_leads ON leads FOR ALL
  USING (current_setting('axion.role', true) IN ('diretor','produtor'));

-- Atendente: só seus leads
CREATE POLICY p_atendente_leads ON leads FOR ALL
  USING (current_setting('axion.role', true) = 'atendente'
         AND atendente_id::text = current_setting('axion.user_id', true));

-- Afiliado: só seus leads
CREATE POLICY p_afiliado_leads ON leads FOR ALL
  USING (current_setting('axion.role', true) = 'afiliado'
         AND afiliado_id::text = current_setting('axion.user_id', true));

-- Recuperador: leads em cobrança/COD pendente (cross-atendente)
CREATE POLICY p_recuperador_leads ON leads FOR SELECT
  USING (current_setting('axion.role', true) = 'recuperador'
         AND modalidade = 'entrega'
         AND status_funil IN ('Cobrança','Frustrado','Enviado','Retirada'));

-- DRE / investimentos / tráfego: apenas diretor e gestor
CREATE POLICY p_invest_diretor ON investimentos FOR ALL
  USING (current_setting('axion.role', true) IN ('diretor','produtor'));

CREATE POLICY p_trafego_gestor ON gastos_trafego FOR ALL
  USING (current_setting('axion.role', true) IN ('diretor','produtor','gestor_trafego'));
