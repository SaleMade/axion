// Teste LOCAL da porta unica da PayLog (14/10/2026): roda o BUNDLE do worker com um D1 de mentira
// (node:sqlite em memoria, schema de producao em teste-schema-producao.json, dados ficticios) e
// manda webhooks do AfterPayLog e da PayLog normal (v2) pelas portas /paylog e /paylog2 de verdade.
// Nao toca em producao: a rede fica bloqueada.
// Uso: npx wrangler deploy --dry-run --outdir <pasta>  e depois  node teste-porta-paylog.mjs <pasta>/worker.js casa
//      (e de novo com cg no lugar de casa)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';

const [bundle, quem] = process.argv.slice(2);   // quem: casa | cg (um por processo: o worker guarda memoria por isolate)
const schema = JSON.parse(readFileSync(new URL('./teste-schema-producao.json', import.meta.url), 'utf8'));
const worker = (await import(pathToFileURL(bundle).href)).default;
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)); };

function novoBanco() {
  const sq = new DatabaseSync(':memory:');
  for (const o of schema) { try { sq.exec(o.sql); } catch (_) { /* indice de tabela virtual etc */ } }
  const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (s) => sq.exec(s) };
  sq.prepare('INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, 1, 0, ?)').run(JSON.stringify({ leads: [], team: [], produtos: [] }), 'teste');
  sq.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('pl_ingest', 'full', 0)").run();
  return { sq, DB };
}

const pend = [];
const ctx = { waitUntil: (pr) => { pend.push(Promise.resolve(pr).catch(() => {})); }, passThroughOnException: () => {} };
const drena = async () => { while (pend.length) await pend.shift(); };
const assina = (seg, corpo) => 'sha256=' + createHmac('sha256', seg).update(corpo).digest('hex');
async function manda(env, caminho, obj, { seg, cab = {} } = {}) {
  const corpo = JSON.stringify(obj);
  const h = { 'content-type': 'application/json', ...cab };
  if (obj && obj.event && String(obj.event).includes('.')) h['x-webhook-event'] = obj.event;
  if (seg) h['x-webhook-signature'] = assina(seg, corpo);
  const r = await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev' + caminho, { method: 'POST', headers: h, body: corpo }), env, ctx);
  await drena();
  return r.status;
}

const v2 = (ev, mexe) => {
  const p = {
    event: ev, event_label: ev, event_timestamp: '2026-10-14T11:02:59-03:00', idempotency_key: 'k-' + ev + Math.random(), cancelable: false,
    order: {
      pedido_id: 175001, codigo_transacao: '175001', referencia_externa: null, plataforma: 'Manual',
      status: { code: 2, label: 'Aguardando Faturamento' }, motivo_parado: null,
      customer: { nome: 'Cliente Exemplo', cpf: '98765432100', email: null, telefone: '5511988887777',
        endereco: { logradouro: 'Rua Exemplo', numero: '45', complemento: null, bairro: 'Centro', cidade: 'Sao Paulo', uf: 'SP', cep: '01001000', pais: 'BR' } },
      items: [{ descricao: 'Tratamento 10 Meses', quantidade: 1, valor_unitario_cents: 99700, produto: { id: 880, nome: 'GLUCOSENSE' } }],
      frete_cents: 0,
    },
    shipment: { tracking_code: null, tracking_url: null, carrier: { code: null, name: null }, tracking_status: { code: null, label: null }, description: null,
      location: null, occurred_at: null, collection_address: null,
      delivery_proof: { image_url: null, signature_url: null, received_by: null, signatory: null, delivery_lat: null, delivery_lng: null } },
    meta: { webhook_version: 2, api_version: 2 },
  };
  if (mexe) mexe(p);
  return p;
};
const rastreio = (p) => { p.shipment.tracking_code = 'AA111222333BR'; p.shipment.tracking_url = 'https://x.rastreio.vip/rastreio/AA111222333BR'; p.shipment.carrier = { code: 'correios', name: 'Correios' }; };
const v1 = (slug, code) => ({ event: slug, event_status: slug, event_timestamp: '2026-10-14T10:00:00-03:00', idempotency_key: 'i' + Math.random(),
  order: { code, customer: { name: 'Cliente After', document: '11122233344', email: null, phone: '5521977776666',
    address: { line: 'Rua Velha 10', neighborhood: 'Centro', city: 'Rio', state: 'RJ', zip: '20000000', country: 'BR' } },
  items: [{ product: { code: 'PRDCRIODL', name: 'Glicosix' }, offer: { code: 'OFRU0DN30', title: 'GlicoSix - 4 Meses (4 Frascos)', price_cents: 49700, number_of_items: 4 } }],
  amount_total_cents: 49700, affiliate: { code: null } } });

const res = [];
const ok = (nome, cond, extra = '') => res.push(`${cond ? 'OK    ' : 'FALHOU'} ${nome}${extra !== '' ? ' (' + extra + ')' : ''}`);

// ── A CASA (worker axion-api: sem WORKER_NAME) ─────────────────────────────────────────────
if (quem !== 'cg') {
  const { sq, DB } = novoBanco();
  const env = { DB, PAYLOG_SECRET: 'seg-after', PAYLOG2_SECRET: 'seg-normal' };
  const estado = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id = 1').get().data);
  const ordem = (oid) => sq.prepare('SELECT * FROM five_orders WHERE order_id = ?').get(oid);
  const log2 = () => sq.prepare('SELECT event, order_code, verified, sig_info, subpath FROM paylog2_debug ORDER BY id').all();

  // AfterPayLog vivo: um evento assinado dele chega primeiro (e entra como sempre entrou)
  let st = await manda(env, '/paylog/glico-six', v1('cadastrado', 'ORDTESTE1'), { seg: 'seg-after' });
  ok('casa: AfterPayLog responde 200', st === 200);
  ok('casa: AfterPayLog continua entrando (five_orders)', !!ordem('PL-ORDTESTE1'));
  ok('casa: AfterPayLog continua com o kit do GlicoSix', ordem('PL-ORDTESTE1') && ordem('PL-ORDTESTE1').offer_id === 'b1c4c1fd-15d4-4cfa-ae6d-ce99f79a6fa4');
  const cardAfter = estado().leads.find((l) => l.five_id === 'PL-ORDTESTE1');
  ok('casa: AfterPayLog criou o card', !!cardAfter);

  // o v2 do MESMO pedido (veio do AfterPayLog) so fica no log
  st = await manda(env, '/paylog2', v2('shipment.in_transit', (p) => { rastreio(p); p.order.plataforma = 'AfterPay Paylog'; p.order.codigo_transacao = 'ORDTESTE1'; }), { seg: 'seg-normal' });
  ok('casa: v2 responde 200', st === 200);
  ok('casa: v2 guardado no log com assinatura ok', log2().length === 1 && log2()[0].verified === 1, JSON.stringify(log2()[0]));
  const cardDepois = estado().leads.find((l) => l.five_id === 'PL-ORDTESTE1');
  ok('casa: v2 de pedido do AfterPayLog NAO mexe no card (o webhook dele ja cobre)', cardDepois && cardDepois.col === cardAfter.col && !cardDepois.track, cardDepois && cardDepois.col);

  // pedido criado DIRETO na PayLog normal entra
  st = await manda(env, '/paylog2', v2('order.created'), { seg: 'seg-normal' });
  const o2 = ordem('PL-175001');
  ok('casa: pedido direto da PayLog normal entra em five_orders', !!o2);
  ok('casa: fonte paylog', o2 && o2.fonte === 'paylog');
  const c2 = estado().leads.find((l) => l.five_id === 'PL-175001');
  ok('casa: e vira card em A Enviar', c2 && c2.col === 'A Enviar', c2 && c2.col);
  ok('casa: endereco separado', c2 && c2.end === 'Rua Exemplo' && c2.num === '45' && c2.cep === '01001000', c2 && [c2.end, c2.num, c2.cep].join('|'));

  // sem assinatura: guardado, nao entra
  await manda(env, '/paylog2', v2('order.created', (p) => { p.order.pedido_id = 175002; p.order.codigo_transacao = '175002'; }));
  ok('casa: v2 sem assinatura NAO entra', !ordem('PL-175002'));
  ok('casa: mas fica no log, marcado', log2().some((l) => l.order_code === '175002' && l.verified === 0 && /sem assinatura/.test(l.sig_info)));

  // assinatura errada
  await manda(env, '/paylog2', v2('order.created', (p) => { p.order.pedido_id = 175003; p.order.codigo_transacao = '175003'; }), { seg: 'outro' });
  ok('casa: v2 com assinatura errada NAO entra', !ordem('PL-175003'));

  // teste do painel deles
  await manda(env, '/paylog2', v2('order.created', (p) => { p.order.pedido_id = 175004; p.order.codigo_transacao = '175004'; }), { seg: 'seg-normal', cab: { 'x-webhook-test': 'true' } });
  ok('casa: teste do painel nao vira pedido', !ordem('PL-175004'));
  ok('casa: teste do painel registrado como teste', log2().some((l) => l.order_code === '175004' && /teste do painel/.test(l.sig_info)));

  // legado (v1 da PayLog normal)
  await manda(env, '/paylog', { dados: { pedido_id: 999, cod_rastreio: 'X', plataforma: 'Manual' } });
  ok('casa: v1 legado da PayLog normal nao entra e fica no log', log2().some((l) => l.event === 'v1-legado') && !ordem('PL-999'));

  // A MESMA URL da tela (/paylog) aceita o v2
  await manda(env, '/paylog', v2('shipment.in_transit', (p) => rastreio(p)), { seg: 'seg-normal' });
  const c3 = estado().leads.find((l) => l.five_id === 'PL-175001');
  ok('casa: v2 pela URL /paylog tambem entra (em transito -> Enviado)', c3 && c3.col === 'Enviado', c3 && c3.col);
  ok('casa: rastreio no card', c3 && c3.track === 'AA111222333BR', c3 && c3.track);

  await manda(env, '/paylog2', v2('shipment.delivered', (p) => rastreio(p)), { seg: 'seg-normal' });
  ok('casa: entregue -> Cobranca', (estado().leads.find((l) => l.five_id === 'PL-175001') || {}).col === 'Cobrança');
  await manda(env, '/paylog2', v2('shipment.delivery_proof', (p) => { rastreio(p); p.shipment.delivery_proof.image_url = 'https://cdn.paylog.cash/x/foto.webp'; p.shipment.delivery_proof.signatory = 'familiar'; }), { seg: 'seg-normal' });
  const c4 = estado().leads.find((l) => l.five_id === 'PL-175001');
  ok('casa: comprovante grava a foto no card', c4 && c4.entrega_url === 'https://cdn.paylog.cash/x/foto.webp' && c4.entrega_assinante === 'familiar');
  ok('casa: comprovante nao mexe na coluna', c4 && c4.col === 'Cobrança', c4 && c4.col);
  ok('casa: um card so por pedido', estado().leads.filter((l) => l.five_id === 'PL-175001').length === 1);
}

// ── A DASH DO GIOVANE (worker axion-api-cg) ─────────────────────────────────────────────────
if (quem !== 'casa') {
  const { sq, DB } = novoBanco();
  const env = { DB, WORKER_NAME: 'axion-api-cg', PAYLOG2_SECRET: 'seg-normal-cg' };
  sq.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('pl_secret', 'http://endereco-colado-errado', 0)").run();
  const estado = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id = 1').get().data);
  const ordem = (oid) => sq.prepare('SELECT * FROM five_orders WHERE order_id = ?').get(oid);

  await manda(env, '/paylog', v2('order.created'), { seg: 'seg-normal-cg' });
  const o = ordem('PL-175001');
  ok('cg: pedido entra com o segredo do servidor mesmo com o campo da tela errado', !!o);
  ok('cg: oferta dele, nao o kit do GlicoSix', o && o.offer_title === 'Tratamento 10 Meses' && o.offer_id === 'PL2-tratamento-10-meses', o && (o.offer_id + ' ' + o.offer_title));
  ok('cg: preco dele (997)', o && Number(o.offer_price) === 997, o && o.offer_price);
  ok('cg: produto dele', o && o.product_name === 'GLUCOSENSE', o && o.product_name);
  const c = estado().leads.find((l) => l.five_id === 'PL-175001');
  ok('cg: card criado em A Enviar', c && c.col === 'A Enviar');
  ok('cg: card com produto e valor dele', c && c.prod === 'GLUCOSENSE' && c.trat === 'Tratamento 10 Meses' && Number(c.vl) === 997, c && [c.prod, c.trat, c.vl].join('|'));
  const kits = (estado().custos && estado().custos.kits) || [];
  ok('cg: kit cadastrado sozinho com o titulo dele', kits.some((k) => String(k.offer_id || k.id || '').startsWith('PL2-') || /Tratamento 10 Meses/.test(JSON.stringify(k))), JSON.stringify(kits).slice(0, 160));

  // sem AfterPayLog nesta dash: pedido de origem AfterPay entra pelo v2
  await manda(env, '/paylog', v2('order.preparing', (p) => { rastreio(p); p.order.plataforma = 'AfterPay Paylog'; p.order.codigo_transacao = 'ORDCGTEST'; p.order.pedido_id = 175100; }), { seg: 'seg-normal-cg' });
  ok('cg: sem webhook do AfterPayLog, o v2 assume o pedido de origem AfterPay', !!ordem('PL-ORDCGTEST'));
  const cP = estado().leads.find((l) => l.five_id === 'PL-ORDCGTEST');
  ok('cg: preparando -> Preparando', cP && cP.col === 'Preparando', cP && cP.col);
}

console.log(res.join('\n'));
const f = res.filter((x) => x.startsWith('FALHOU')).length;
console.log(f ? `\n${f} FALHA(S)` : `\nTUDO PASSOU (${res.length})`);
process.exit(f ? 1 : 0);
