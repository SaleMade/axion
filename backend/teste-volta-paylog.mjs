// Teste LOCAL da VOLTA do pedido na PayLog (21/10/2026): roda o BUNDLE do worker com um D1 de mentira
// (node:sqlite em memoria, schema de producao, dados ficticios) e manda pela porta /paylog a sequencia
// que o ORDQLWP2C fez de verdade: o AfterPayLog avisa o ao_remetente e fica mudo; a PayLog normal (v2)
// manda a volta inteira com order.status "Ao Remetente" ate a encomenda chegar em Indaiatuba/SP.
// Confere a tabela pl_volta, o GET /api/devolucoes/plataforma (quem le e quem nao le), o refazer pelo
// log, e que o "devolvido" do v2 passa mesmo com o AfterPayLog vivo. Nao toca em producao.
// Uso: npx wrangler deploy --dry-run --outdir <pasta>  e depois  node teste-volta-paylog.mjs <pasta>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';

const [bundle] = process.argv.slice(2);
const schema = JSON.parse(readFileSync(new URL('./teste-schema-producao.json', import.meta.url), 'utf8'));
// O bundle importa cloudflare:sockets, que o node nao abre: vira uma classe vazia numa copia ao lado.
const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm, (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-volta.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)); };

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
const agoraS = Math.floor(Date.now() / 1000);
const tok = (id) => createHmac('sha256', 'sessao').update(id).digest('hex');   // a sessao e 64 hex
for (const [id, role, afl] of [['dir', 'diretor'], ['at_vend', 'atendente'], ['gestor1', 'gestor'], ['afl_user', 'afiliado', 'afl_teste1'], ['afl_outro', 'afiliado', 'afl_teste2']]) {
  sq.prepare('INSERT INTO users (id, login, pwd_hash, name, role, afiliado_id) VALUES (?,?,?,?,?,?)').run(id, id, 'x', id, role, afl || null);
  sq.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(tok(id), id, agoraS, agoraS + 3600);
}
const env = { DB, PAYLOG_SECRET: 'seg-after', PAYLOG2_SECRET: 'seg-normal' };

const pend = [];
const ctx = { waitUntil: (pr) => { pend.push(Promise.resolve(pr).catch(() => {})); }, passThroughOnException: () => {} };
const drena = async () => { while (pend.length) await pend.shift(); };
const assina = (seg, corpo) => 'sha256=' + createHmac('sha256', seg).update(corpo).digest('hex');
async function manda(obj, seg) {
  const corpo = JSON.stringify(obj);
  const h = { 'content-type': 'application/json' };
  if (obj && obj.event && String(obj.event).includes('.')) h['x-webhook-event'] = obj.event;
  if (seg) h['x-webhook-signature'] = assina(seg, corpo);
  const r = await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev/paylog/glico-six', { method: 'POST', headers: h, body: corpo }), env, ctx);
  await drena();
  return r.status;
}
async function le(caminho, quem) {
  const h = quem ? { authorization: 'Bearer ' + tok(quem) } : {};
  const r = await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev' + caminho, { headers: h }), env, ctx);
  await drena();
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}

const CODE = 'ORDVOLTA1';
const v1 = (slug) => ({ event: slug, event_status: slug, event_timestamp: '2026-10-13T07:24:45-03:00', idempotency_key: 'i' + Math.random(),
  order: { code: CODE, customer: { name: 'Cliente Volta', document: '11122233344', email: null, phone: '5521977776666',
    address: { line: 'Rua Velha 10', neighborhood: 'Centro', city: 'Mage', state: 'RJ', zip: '25900000', country: 'BR' } },
  items: [{ product: { code: 'PRDCRIODL', name: 'Glicosix' }, offer: { code: 'OFR3H0WKD', title: 'GlicoSix - 3 Meses (3 Frascos)', price_cents: 39700, number_of_items: 3 } }],
  amount_total_cents: 39700, affiliate: { code: null } } });
const v2 = (ev, status, quando, desc, local, codigo = CODE, plataforma = 'AfterPay Paylog') => ({
  event: ev, event_label: desc, event_timestamp: quando, idempotency_key: 'k' + Math.random(), cancelable: false,
  order: { pedido_id: 162217, codigo_transacao: codigo, referencia_externa: codigo, plataforma, status, motivo_parado: null,
    customer: { nome: 'Cliente Volta', cpf: '11122233344', email: null, telefone: '5521977776666',
      endereco: { logradouro: 'Rua Velha', numero: '10', complemento: null, bairro: 'Centro', cidade: 'Mage', uf: 'RJ', cep: '25900000', pais: 'BR' } },
    items: [{ descricao: 'GlicoSix - 3 Meses (3 Frascos)', quantidade: 3, valor_unitario_cents: 39700, produto: { id: 816, nome: 'Glicosix' } }], frete_cents: 2001 },
  shipment: { tracking_code: '888030971048245', tracking_url: null, carrier: { code: 'jt-express', name: 'J&T' }, tracking_status: { code: 30, label: desc },
    description: desc, location: local, occurred_at: quando, collection_address: null,
    delivery_proof: { image_url: null, signature_url: null, received_by: null, signatory: null, delivery_lat: null, delivery_lng: null } },
  meta: { webhook_version: 2, api_version: 2 },
});
const ENVIADO = { code: 7, label: 'Enviado' }, VOLTA = { code: 20, label: 'Ao Remetente' };
const s = (iso) => Math.floor(Date.parse(iso) / 1000);

const res = [];
const ok = (nome, cond, extra = '') => res.push(`${cond ? 'OK    ' : 'FALHOU'} ${nome}${extra !== '' ? ' (' + extra + ')' : ''}`);
const volta = () => { try { return sq.prepare('SELECT * FROM pl_volta WHERE order_id = ?').get('PL-' + CODE); } catch (_) { return undefined; } };   // a tabela nasce no primeiro evento da volta
const ordem = () => sq.prepare('SELECT shipping_status, last_status FROM five_orders WHERE order_id = ?').get('PL-' + CODE);
const card = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id = 1').get().data).leads.find((l) => l.five_id === 'PL-' + CODE);

// 1) a ida: AfterPayLog cria (e fica vivo), v2 posta em Indaiatuba e leva pra Mage
await manda(v1('cadastrado'), 'seg-after');
await manda(v1('em_transito'), 'seg-after');
await manda(v2('shipment.posted', ENVIADO, '2026-10-07T11:11:03-03:00', 'Coleta Realizada', 'Indaiatuba/SP'), 'seg-normal');
await manda(v2('shipment.in_transit', ENVIADO, '2026-10-10T07:20:12-03:00', 'Chegada na Unidade', 'Magé/RJ'), 'seg-normal');
ok('ida nao abre volta', !volta());

// 2) a volta comeca: o AfterPayLog avisa e cala; o v2 manda o returning
await manda(v1('ao_remetente'), 'seg-after');
await manda(v2('shipment.returning', VOLTA, '2026-10-13T07:24:44-03:00', 'Em Devolução', 'Magé/RJ'), 'seg-normal');
let v = volta();
ok('returning abre a volta', !!v);
ok('comeco = hora do returning', v && v.inicio_ts === s('2026-10-13T07:24:44-03:00'), v && v.inicio_ts);
ok('origem = cidade da postagem', v && v.origem === 'Indaiatuba/SP', v && v.origem);
ok('ainda nao chegou', v && v.chegou_ts === null);
ok('pedido em RETURNING_TO_ORIGIN', ordem() && ordem().shipping_status === 'RETURNING_TO_ORIGIN', ordem() && ordem().shipping_status);

// 3) os movimentos da volta (in_transit com "Ao Remetente") ate Indaiatuba
await manda(v2('shipment.in_transit', VOLTA, '2026-10-15T20:50:55-03:00', 'Chegada ao Centro de Distribuição', 'Barueri/SP'), 'seg-normal');
v = volta();
ok('movimento atualiza onde esta', v && v.ult_local === 'Barueri/SP' && v.ult_desc === 'Chegada ao Centro de Distribuição', v && (v.ult_local + ' ' + v.ult_desc));
ok('em transito da volta NAO leva o pedido pra Em Transito', ordem().shipping_status === 'RETURNING_TO_ORIGIN', ordem().shipping_status);
await manda(v2('shipment.in_transit', VOLTA, '2026-10-19T17:31:26-03:00', 'Chegada na Unidade', 'Indaiatuba/SP'), 'seg-normal');
v = volta();
ok('chegou na cidade de origem', v && v.chegou_ts === s('2026-10-19T17:31:26-03:00'), v && v.chegou_ts);
// evento velho chegando atrasado nao volta o ponteiro
await manda(v2('shipment.in_transit', VOLTA, '2026-10-14T06:21:02-03:00', 'Saída da Unidade', 'Magé/RJ'), 'seg-normal');
v = volta();
ok('evento atrasado nao volta o "onde esta"', v && v.ult_local === 'Indaiatuba/SP', v && v.ult_local);
ok('evento atrasado nao muda o comeco nem a chegada', v && v.inicio_ts === s('2026-10-13T07:24:44-03:00') && v.chegou_ts === s('2026-10-19T17:31:26-03:00'));
ok('ainda nao devolvido', v && v.devolvido_ts === null);

// 4) a PayLog encerra a volta: o devolvido passa mesmo com o AfterPayLog vivo
await manda(v2('shipment.returned', VOLTA, '2026-10-21T10:47:50-03:00', 'Devolvido', 'Indaiatuba/SP'), 'seg-normal');
v = volta();
ok('devolvido anotado', v && v.devolvido_ts === s('2026-10-21T10:47:50-03:00'), v && v.devolvido_ts);
ok('pedido vira RETURNED (passou pela trava do AfterPayLog)', ordem().shipping_status === 'RETURNED', ordem().shipping_status);
ok('card em Devolvido', card() && card().col === 'Devolvido', card() && card().col);

// 5) sem assinatura nao anota
await manda(v2('shipment.returning', VOLTA, '2026-10-13T07:24:44-03:00', 'Em Devolução', 'Magé/RJ', 'ORDFORJADO'));
ok('evento sem assinatura nao abre volta', !sq.prepare('SELECT 1 x FROM pl_volta WHERE order_id = ?').get('PL-ORDFORJADO'));

// 6) pedido direto da PayLog normal (sem AfterPayLog): a volta em transito nao vira Em Transito
await manda(v2('shipment.posted', ENVIADO, '2026-10-07T11:11:03-03:00', 'Coleta Realizada', 'Indaiatuba/SP', '777001', 'Manual'), 'seg-normal');
await manda(v2('shipment.returning', VOLTA, '2026-10-13T08:00:00-03:00', 'Em Devolução', 'Recife/PE', '777001', 'Manual'), 'seg-normal');
await manda(v2('shipment.in_transit', VOLTA, '2026-10-14T08:00:00-03:00', 'Saída da Unidade', 'Recife/PE', '777001', 'Manual'), 'seg-normal');
const dir = sq.prepare('SELECT shipping_status FROM five_orders WHERE order_id = ?').get('PL-162217');
ok('pedido direto: volta em transito segue RETURNING_TO_ORIGIN', dir && dir.shipping_status === 'RETURNING_TO_ORIGIN', dir && dir.shipping_status);
await manda(v2('shipment.delivered', VOLTA, '2026-10-18T08:00:00-03:00', 'Entregue', 'Indaiatuba/SP', '777001', 'Manual'), 'seg-normal');
const dir2 = sq.prepare('SELECT shipping_status FROM five_orders WHERE order_id = ?').get('PL-162217');
ok('pedido direto: entregue na volta = RETURNED, nao Cobranca', dir2 && dir2.shipping_status === 'RETURNED', dir2 && dir2.shipping_status);
const vd = sq.prepare('SELECT * FROM pl_volta WHERE order_id = ?').get('PL-162217');
ok('pedido direto: chegou e devolvido anotados', vd && vd.chegou_ts === s('2026-10-18T08:00:00-03:00') && vd.devolvido_ts === s('2026-10-18T08:00:00-03:00'));

// 7) a leitura
let r = await le('/api/devolucoes/plataforma');
ok('sem sessao: 401', r.status === 401, r.status);
r = await le('/api/devolucoes/plataforma', 'at_vend');
ok('vendedor: 403', r.status === 403, r.status);
r = await le('/api/devolucoes/plataforma', 'gestor1');
ok('gestor le', r.status === 200 && Array.isArray(r.j.voltas) && r.j.voltas.length === 2, r.status + ' ' + (r.j && r.j.voltas && r.j.voltas.length));
r = await le('/api/devolucoes/plataforma', 'dir');
const linha = r.j && r.j.voltas && r.j.voltas.find((x) => x.order_id === 'PL-' + CODE);
ok('diretor le a volta do pedido', !!linha && linha.chegou_ts === s('2026-10-19T17:31:26-03:00') && linha.ult_local === 'Indaiatuba/SP');
ok('a resposta nao leva dado do cliente', !!linha && !JSON.stringify(r.j).includes('Cliente Volta') && !JSON.stringify(r.j).includes('11122233344'));

// 7b) o afiliado ve a volta do pedido DELE (o card tem lead.afl), mesmo tendo entrado pela porta da casa
const est = JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id = 1').get().data);
for (const l of est.leads) if (l.five_id === 'PL-' + CODE) l.afl = 'afl_teste1';
sq.prepare('UPDATE dashboard_state SET data = ?, version = version + 1 WHERE id = 1').run(JSON.stringify(est));
r = await le('/api/devolucoes/plataforma', 'afl_user');
ok('afiliado ve so a volta do pedido dele', r.status === 200 && r.j.voltas.length === 1 && r.j.voltas[0].order_id === 'PL-' + CODE, r.status + ' ' + JSON.stringify((r.j && r.j.voltas || []).map((x) => x.order_id)));
r = await le('/api/devolucoes/plataforma', 'afl_outro');
ok('outro afiliado nao ve', r.status === 200 && r.j.voltas.length === 0, JSON.stringify(r.j));
ok('a resposta nao diz de que porta veio', !JSON.stringify(r.j).includes('mundo'));

// 8) refazer pelo log
sq.exec('DELETE FROM pl_volta');
r = await le('/api/devolucoes/plataforma?refazer=1', 'gestor1');
ok('gestor nao refaz (so le)', r.status === 200 && r.j.refeitos === undefined && r.j.voltas.length === 0, JSON.stringify(r.j).slice(0, 80));
r = await le('/api/devolucoes/plataforma?refazer=1', 'dir');
const l2 = r.j && r.j.voltas && r.j.voltas.find((x) => x.order_id === 'PL-' + CODE);
ok('diretor refaz pelo log e chega no mesmo resultado', !!l2 && l2.inicio_ts === s('2026-10-13T07:24:44-03:00') && l2.chegou_ts === s('2026-10-19T17:31:26-03:00') && l2.devolvido_ts === s('2026-10-21T10:47:50-03:00') && l2.ult_local === 'Indaiatuba/SP', JSON.stringify(l2));
ok("o refazer nao inventa volta do pedido forjado", !!(r.j && r.j.voltas) && !r.j.voltas.some((x) => x.order_id === 'PL-ORDFORJADO'));

console.log(res.join('\n'));
const falhou = res.filter((x) => x.startsWith('FALHOU')).length;
console.log(falhou ? `\nFALHOU ${falhou} de ${res.length}` : `\nTUDO PASSOU (${res.length})`);
process.exit(falhou ? 1 : 0);
