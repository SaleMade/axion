// ═══════════════════════════════════════════════════════════════
// AXION — Cloudflare Worker (webhook receiver)
//
// Recebe POST de PAYT / Correios / outras plataformas, valida
// HMAC, mapeia evento → ação interna, persiste no D1 e responde
// imediatamente (200 OK em <50ms).
//
// Deploy:
//   1. npm i -g wrangler
//   2. wrangler login
//   3. wrangler d1 create axion
//      (cole o database_id no wrangler.toml)
//   4. wrangler d1 execute axion --file=schema.sql
//   5. wrangler secret put PAYT_WEBHOOK_SECRET
//      (cole o token gerado no painel PAYT)
//   6. wrangler deploy
//
// Endpoints:
//   POST /webhook/payt/:token   ← PAYT
//   POST /webhook/correios      ← Correios (sem assinatura, valida IP)
//   POST /webhook/custom/:tok   ← genérico (Hotmart/Kiwify/Eduzz/Braip)
//   GET  /healthz
//
// ─── COMO ADICIONAR UMA NOVA PLATAFORMA ─────────────────────────
// 1. Adicionar variável pública em wrangler.toml [vars]:
//      MINHA_PLAT_PUBLIC_TOKEN = "axn_minha_xyz123"
// 2. Adicionar secret HMAC (opcional):
//      wrangler secret put MINHA_PLAT_WEBHOOK_SECRET
// 3. Adicionar route handler abaixo:
//      if (route.startsWith('/webhook/minha/')) { ... }
// 4. Criar handler async handleMinhaEvent(env, payload) que mapeia
//    para os mesmos status_funil internos (Pago / Cobrança / etc).
//
// O receptor é stateless e horizontalmente escalável (Cloudflare edge).
// Resposta 200 OK em <50ms — processamento via ctx.waitUntil() async.
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // health check
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, ts: Date.now() });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const route = url.pathname;
    const raw = await request.text();

    try {
      // ─── PAYT ──────────────────────────────────────────────
      if (route.startsWith('/webhook/payt/')) {
        const token = route.split('/').pop();
        if (token !== env.PAYT_PUBLIC_TOKEN) {
          return new Response('Invalid public token', { status: 401 });
        }
        // PAYT envia HMAC-SHA256 em hexadecimal no header
        const sig = request.headers.get('X-Payt-Signature') || '';
        const expected = await hmacHex(env.PAYT_WEBHOOK_SECRET, raw);
        if (!constantTimeEqual(sig, expected)) {
          await logAttempt(env, 'PAYT', 'invalid_signature', raw);
          return new Response('Invalid signature', { status: 401 });
        }
        const payload = JSON.parse(raw);
        // dispara processamento sem bloquear resposta (resposta < 50ms)
        ctx.waitUntil(handlePaytEvent(env, payload));
        return Response.json({ received: true });
      }

      // ─── Correios (rastreio) ───────────────────────────────
      if (route === '/webhook/correios') {
        const allowed = (env.CORREIOS_IP_ALLOWLIST || '').split(',').map(s => s.trim());
        const cf = request.headers.get('CF-Connecting-IP') || '';
        if (allowed.length && !allowed.includes(cf)) {
          return new Response('IP not allowed', { status: 403 });
        }
        const payload = JSON.parse(raw);
        ctx.waitUntil(handleCorreiosEvent(env, payload));
        return Response.json({ received: true });
      }

      // ─── Genérico (Hotmart/Kiwify/etc) ─────────────────────
      if (route.startsWith('/webhook/custom/')) {
        const token = route.split('/').pop();
        if (token !== env.CUSTOM_PUBLIC_TOKEN) {
          return new Response('Invalid token', { status: 401 });
        }
        const payload = JSON.parse(raw);
        ctx.waitUntil(handleCustomEvent(env, payload));
        return Response.json({ received: true });
      }

      return new Response('Not found', { status: 404 });

    } catch (err) {
      await logAttempt(env, 'ERROR', err.message, raw);
      return new Response('Bad request: ' + err.message, { status: 400 });
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// PAYT event handler
// ═══════════════════════════════════════════════════════════════
// Eventos REAIS da PAYT (13 eventos disponíveis no painel deles):
//   aguardando_pagamento, finalizada, faturada, cancelada,
//   cancelada_chargeback, cancelada_reembolsada, abandono_checkout,
//   entrega_atualizada, solicitacao_reembolso, pagamento_expirado,
//   aguardando_confirmacao, pedido_confirmado, pedido_frustrado
//
// O mapeamento evento → etapa CRM é configurável pelo usuário
// na tabela `payt_mapping` do banco — esta função usa essa tabela.

async function handlePaytEvent(env, payload) {
  const event = payload.event;
  const data  = payload.data || {};
  const cpf   = data.customer?.cpf;
  const email = data.customer?.email;
  const txid  = data.transaction_id;

  // Busca configuração do mapping
  const mapping = await env.DB.prepare(
    'SELECT etapa, spg, action, tag FROM payt_mapping WHERE evento=?'
  ).bind(event).first();

  if (!mapping) {
    await logAttempt(env, 'PAYT', event, JSON.stringify(payload), null, 'unknown_event');
    return;
  }

  // Localiza lead (CPF > email > tracking_id)
  let lead = await findLead(env, { cpf, email, txid });
  let leadId = lead?.id;

  // Cria lead se não existir e ação for 'criar_lead' (ex: abandono_checkout)
  if (!lead && mapping.action === 'criar_lead') {
    const newLead = await createLead(env, {
      nome: data.customer?.name,
      cpf, email,
      whatsapp: data.customer?.phone,
      produto_nome: data.product?.name,
      valor: data.amount,
      status_funil: mapping.etapa || 'Cobrança',
      origem: 'PAYT',
    });
    leadId = newLead.id;
    if (mapping.tag) await addTags(env, leadId, [mapping.tag]);
    await assignToRecuperador(env, leadId);
    await logAttempt(env, 'PAYT', event, JSON.stringify(payload), leadId, 'lead_created');
    return;
  }

  if (!lead) {
    await logAttempt(env, 'PAYT', event, JSON.stringify(payload), null, 'lead_not_found');
    return;
  }

  // Ação 'rastreio': só atualiza dados de rastreio sem mover etapa
  if (mapping.action === 'rastreio') {
    await updateLead(env, lead.id, {
      ultimo_evento_correios: data.tracking_status,
      ultimo_evento_em: new Date().toISOString(),
    });
    await logAttempt(env, 'PAYT', event, JSON.stringify(payload), lead.id, 'tracking_updated');
    return;
  }

  // Atualiza etapa + status_pgto conforme mapping
  const updates = {};
  if (mapping.etapa) updates.status_funil = mapping.etapa;
  if (mapping.spg)   updates.status_pgto  = mapping.spg;
  if (data.payment_method) updates.metodo_pgto = data.payment_method;
  if (data.amount)         updates.valor       = data.amount;
  if (data.boleto_url || data.pix_url || data.checkout_url) {
    updates.link_checkout = data.boleto_url || data.pix_url || data.checkout_url;
  }
  await updateLead(env, lead.id, updates);

  // Tag adicional configurada
  if (mapping.action === 'tag' && mapping.tag) {
    await addTags(env, lead.id, [mapping.tag]);
  }

  // Ação 'pagar': dispara trigger de criar venda (já é feito pelo trigger SQL no Postgres)
  // Action 'mover': já feito acima.

  await logAttempt(env, 'PAYT', event, JSON.stringify(payload), lead.id, mapping.action);
}

// ═══════════════════════════════════════════════════════════════
// Correios event handler
// ═══════════════════════════════════════════════════════════════
async function handleCorreiosEvent(env, payload) {
  const tracking = payload.tracking_code;
  const status   = payload.status;        // 'postado'|'cidade_destino'|'saiu_entrega'|'entregue'|'devolvido'
  const lead = await findLeadByTracking(env, tracking);
  if (!lead) return;

  switch (status) {
    case 'postado':
      await updateLead(env, lead.id, { status_funil: 'Enviado' });
      break;
    case 'cidade_destino':
      await updateLead(env, lead.id, {
        cidade_destino_atingida: true,
        follow_up_flag: 'cidade_destino',
      });
      await createFollowup(env, lead.id, 'cidade_destino',
        'Pedido chegou na cidade — confirmar com cliente');
      break;
    case 'saiu_entrega':
      await addTags(env, lead.id, ['entrega-hoje']);
      break;
    case 'entregue':
      await updateLead(env, lead.id, { status_funil: 'Retirada' });
      break;
    case 'devolvido':
      await updateLead(env, lead.id, { status_funil: 'Devolvido' });
      break;
  }
  await logAttempt(env, 'Correios', status, JSON.stringify(payload), lead.id);
}

// ═══════════════════════════════════════════════════════════════
// Genérico (Hotmart/Kiwify/Eduzz)
// ═══════════════════════════════════════════════════════════════
async function handleCustomEvent(env, payload) {
  // mapeia para o formato PAYT e reaproveita
  const mapped = mapToInternalFormat(payload);
  if (mapped) await handlePaytEvent(env, mapped);
}

function mapToInternalFormat(payload) {
  // exemplo Hotmart
  if (payload.event === 'PURCHASE_APPROVED') {
    return {
      event: 'compra.aprovada',
      data: {
        customer: payload.data?.buyer,
        transaction_id: payload.data?.purchase?.transaction,
        amount: payload.data?.purchase?.price?.value,
        payment_method: payload.data?.purchase?.payment?.type,
        product: payload.data?.product,
      }
    };
  }
  // ... adicione outros mapeamentos
  return null;
}

// ═══════════════════════════════════════════════════════════════
// HMAC + utilitários crypto
// ═══════════════════════════════════════════════════════════════
async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

// ═══════════════════════════════════════════════════════════════
// Camada de banco (D1)
// ═══════════════════════════════════════════════════════════════
async function findLead(env, { cpf, email, txid }) {
  const sql = `SELECT id FROM leads WHERE
    (? IS NOT NULL AND cpf=?) OR (? IS NOT NULL AND email=?)
    LIMIT 1`;
  const r = await env.DB.prepare(sql).bind(cpf, cpf, email, email).first();
  return r;
}

async function findLeadByTracking(env, tracking) {
  return env.DB.prepare(
    'SELECT id FROM leads WHERE codigo_rastreio=? LIMIT 1'
  ).bind(tracking).first();
}

async function updateLead(env, id, fields) {
  const cols = Object.keys(fields);
  const vals = cols.map(c => fields[c]);
  const set  = cols.map(c => `${c}=?`).join(',');
  await env.DB.prepare(`UPDATE leads SET ${set}, updated_at=datetime('now') WHERE id=?`)
    .bind(...vals, id).run();
}

async function createLead(env, lead) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO leads
    (id, nome, cpf, email, whatsapp, produto_nome, valor, status_funil, origem, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .bind(id, lead.nome, lead.cpf, lead.email, lead.whatsapp,
          lead.produto_nome, lead.valor, lead.status_funil, lead.origem)
    .run();
  return { id };
}

async function addTags(env, leadId, tags) {
  for (const t of tags) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO lead_tags(lead_id, tag) VALUES(?, ?)`
    ).bind(leadId, t).run();
  }
}

async function assignToRecuperador(env, leadId) {
  // pega primeiro recuperador disponível (round-robin é evolução futura)
  const r = await env.DB.prepare(
    `SELECT id FROM users WHERE role='recuperador' AND ativo=1 LIMIT 1`
  ).first();
  if (r) await updateLead(env, leadId, { atendente_id: r.id });
}

async function scheduleFollowup(env, leadId, when, msg) {
  await env.DB.prepare(`INSERT INTO follow_ups
    (lead_id, tipo, mensagem, agendado_em)
    VALUES(?, 'agendamento', ?, datetime('now', ?))`)
    .bind(leadId, msg, when).run();
}

async function createFollowup(env, leadId, tipo, msg) {
  await env.DB.prepare(`INSERT INTO follow_ups
    (lead_id, tipo, mensagem, agendado_em)
    VALUES(?, ?, ?, datetime('now'))`)
    .bind(leadId, tipo, msg).run();
}

async function logAttempt(env, origem, evento, payload, leadId = null, action = null) {
  try {
    await env.DB.prepare(`INSERT INTO webhooks_log
      (origem, evento, payload, lead_id, action, recebido_em)
      VALUES(?, ?, ?, ?, ?, datetime('now'))`)
      .bind(origem, evento, payload, leadId, action).run();
  } catch (e) {
    console.error('Failed to log webhook:', e.message);
  }
}
