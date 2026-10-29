// Teste LOCAL do ContaSimples pelo servidor (29/10/2026): roda o BUNDLE do worker com um D1 de mentira
// (node:sqlite em memoria, schema de producao) e uma API do ContaSimples de mentira (fetch trocado).
// Confere: a normalizacao do cartao e da conta (sinal, fuso, centro de custo), a carga inicial mes a
// mes, a cobranca PENDING que some do extrato, quem le o GET /api/cs/extrato (diretor tudo, gestor so
// o cartao de anuncio, vendedor e afiliado nada), o POST /api/cs/mapa e o frete real da PayLog (v2).
// Nao toca em producao.
// Uso: npx wrangler deploy --dry-run --outdir <pasta>  e depois  node teste-contasimples.mjs <pasta>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.log('uso: node teste-contasimples.mjs <pasta>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-schema-producao.json', import.meta.url), 'utf8'));
const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm, (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-cs.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;

// ── a API do ContaSimples de mentira ───────────────────────────────────────────────────────────
let CARTAO = [], CONTA = [], pedidos = [];
const resp = (obj, st = 200) => new Response(JSON.stringify(obj), { status: st, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (u, init) => {
  const url = new URL(typeof u === 'string' ? u : u.url);
  if (url.host !== 'api.contasimples.com') throw new Error('rede bloqueada no teste: ' + url.host);
  pedidos.push(url.pathname + url.search);
  if (url.pathname === '/oauth/v1/access-token') {
    const auth = (init && init.headers && init.headers.Authorization) || '';
    return auth === 'Basic ' + btoa('chave:segredo') ? resp({ access_token: 'tk', expires_in: 1800 }) : resp({ error: 'x' }, 401);
  }
  const de = url.searchParams.get('startDate'), ate = url.searchParams.get('endDate');
  const doDia = (t) => { const d = new Date(Date.parse(t.transactionDate) - 3 * 3600000).toISOString().slice(0, 10); return d >= de && d <= ate; };
  if (url.pathname === '/statements/v1/credit-card') return resp({ transactions: CARTAO.filter(doDia), nextPageStartKey: null });
  if (url.pathname === '/statements/v1/banking') {
    // pagina de 2 em 2 pra exercitar o nextPageStartKey
    const todos = CONTA.filter(doDia);
    const ini = Number(url.searchParams.get('nextPageStartKey') || 0);
    const fatia = todos.slice(ini, ini + 2);
    return resp({ transactions: fatia, nextPageStartKey: ini + 2 < todos.length ? String(ini + 2) : null });
  }
  if (url.pathname === '/accounts/v1/balance') return resp({ amount: 7393.33 });
  return resp({}, 404);
};

const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) { /* indice de tabela virtual etc */ } }
try { sq.exec('ALTER TABLE five_orders ADD COLUMN frete_real REAL'); } catch (_) {}
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a.map(conv)),
  first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
  all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
  run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => { const out = []; for (const s of l) out.push(await s.run()); return out; }, exec: async (s) => sq.exec(s) };
sq.prepare('INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, 1, 0, ?)').run(JSON.stringify({ leads: [], team: [], produtos: [] }), 'teste');
sq.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('pl_ingest', 'full', 0)").run();
const agoraS = Math.floor(Date.now() / 1000);
const tok = (id) => createHmac('sha256', 'sessao').update(id).digest('hex');
for (const [id, role, afl] of [['dir', 'diretor'], ['socio1', 'socio'], ['at_vend', 'atendente'], ['gestor1', 'gestor'], ['afl_user', 'afiliado', 'afl_teste1']]) {
  sq.prepare('INSERT INTO users (id, login, pwd_hash, name, role, afiliado_id) VALUES (?,?,?,?,?,?)').run(id, id, 'x', id, role, afl || null);
  sq.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(tok(id), id, agoraS, agoraS + 3600);
}
const env = { DB, CS_API_KEY: 'chave', CS_API_SECRET: 'segredo', PAYLOG_SECRET: 'seg-after', PAYLOG2_SECRET: 'seg-normal' };
const pend = [];
const ctx = { waitUntil: (pr) => { pend.push(Promise.resolve(pr).catch(() => {})); }, passThroughOnException: () => {} };
const drena = async () => { while (pend.length) await pend.shift(); };
async function chama(metodo, caminho, quem, corpo) {
  const h = { 'content-type': 'application/json' };
  if (quem) h.authorization = 'Bearer ' + tok(quem);
  const r = await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev' + caminho, { method: metodo, headers: h, body: corpo ? JSON.stringify(corpo) : undefined }), env, ctx);
  await drena();
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}

let ok = 0, ruim = 0;
const conf = (c, msg, extra) => { if (c) { ok++; console.log('  ok   ' + msg); } else { ruim++; console.log('  RUIM ' + msg + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); } };

// ── extrato de mentira (formato real da API, conferido em 29/10/2026) ─────────────────────────────
const card = (id, quando, op, tipo, valor, status, cat, centro, final, merchant) => ({
  id, operation: op, transactionDate: quando, status, type: tipo, merchant, amountBrl: valor,
  card: { id: 'k' + final, maskedNumber: '•••• ' + final, responsibleName: 'Heynan Oliveira Dantas' },
  category: cat ? { id: '1', name: cat } : null, costCenter: centro ? { id: '2', name: centro } : null,
});
const conta = (id, quando, desc, sub, valor, quem, centro, cat, descr) => ({
  id, transactionType: { id: 1, description: desc, subType: sub }, status: 2, statusDescription: sub || desc === 'Rentabilidade CDI' ? 'PROCESSED' : '',
  transactionDate: quando, brlAmount: valor, sourceDestinationName: quem, description: descr || '',
  category: cat ? { id: 'c', description: cat } : null, costCenter: centro ? { id: 'cc', description: centro } : null, user: { email: 'x@y' },
});
CARTAO = [
  card('A1', '2026-08-10T15:00:00.000Z', 'CASH_OUT', 'PURCHASE', 500, 'PROCESSED', 'Publicidade e Anuncios', 'BM Nova - 01', '6273', 'TIKTOK ADS'),
  card('A2', '2026-08-10T15:00:01.000Z', 'CASH_OUT', 'IOF', 17.5, 'PROCESSED', null, null, '6273', 'TIKTOK ADS'),
  card('A3', '2026-09-02T12:00:00.000Z', 'CASH_OUT', 'PURCHASE_INTERNATIONAL', 53.77, 'PROCESSED', 'Ferramentas e softwares', 'Investimento Ferramentas', '6042', 'DECODO.COM'),
  card('A4', '2026-10-28T12:00:00.000Z', 'CASH_OUT', 'PURCHASE', 1680, 'PENDING', 'Publicidade e Anuncios', 'BM Nova - 01', '6273', 'TikTok Ads'),
  // 22h de 31/10 em Brasilia = 01/11 01h em UTC: o dia tem que ser 31/10
  card('A5', '2026-11-01T01:00:00.000Z', 'CASH_OUT', 'PURCHASE', 200, 'PROCESSED', 'Publicidade e Anuncios', 'BM Nova - 01', '6273', 'TIKTOK ADS'),
  card('A6', '2026-10-05T12:00:00.000Z', 'CASH_IN', 'LIMIT', 3000, 'PROCESSED', 'Movimentações', null, null, ''),
];
CONTA = [
  conta(11, '2026-09-23T12:00:00.000Z', 'PIX Enviado', 'PIX_OUT', 1700, 'HAYNAN OLIVEIRA DANTAS', 'Pagamentos Haynan'),
  conta(12, '2026-10-15T12:00:00.000Z', 'PIX Enviado', 'PIX_OUT', 13000, 'ELLO ENCAPSULADOS', 'Five - Custos Potes'),
  conta(13, '2026-10-15T12:00:00.000Z', 'Recebimento via PIX', 'PIX_IN', 497, 'CLIENTE X'),
  conta(14, '2026-10-16T12:00:00.000Z', 'Rentabilidade CDI', null, 1.58, ''),
  conta(15, '2026-10-16T12:00:00.000Z', 'Geração Boleto: Tarifa', null, 2.89, ''),
  conta(16, '2026-10-05T12:00:00.000Z', 'Transferência de limite', 'SECURED_CARD_DEPOSIT_OUT', 3000, 'CONTA SIMPLES'),
];

console.log('\n1. CARGA INICIAL (tabela vazia): um mes por rodada desde junho');
const cronCs = async () => { await worker.scheduled({ scheduledTime: Date.now() }, env, ctx); await drena(); };
// a funcao do cron e interna; o caminho publico pra forcar e o POST /api/cs/sync com periodo
let r = await chama('POST', '/api/cs/sync', 'dir', { de: '2026-08-01', ate: '2026-10-31' });
conf(r.status === 200 && r.j && r.j.ok, 'POST /api/cs/sync com periodo responde ok', r);
const n = sq.prepare('SELECT COUNT(*) n FROM cs_tx').get().n;
conf(n === CARTAO.length + CONTA.length, 'as ' + (CARTAO.length + CONTA.length) + ' transacoes viraram linhas (paginacao da conta de 2 em 2)', n);
const linha = (id) => sq.prepare('SELECT * FROM cs_tx WHERE id = ?').get(id);
conf(linha('c:A1').sentido === 'saida' && linha('c:A1').centro === 'BM Nova - 01' && linha('c:A1').cartao === '6273' && linha('c:A1').dia === '2026-08-10', 'compra do cartao: saida, centro, final 6273, dia', linha('c:A1'));
conf(linha('c:A5').dia === '2026-10-31', 'compra das 22h de 31/10 (Brasilia) fica em 31/10', linha('c:A5').dia);
conf(linha('c:A6').sentido === 'entrada' && linha('c:A6').tipo === 'LIMIT', 'limite do cartao entra como LIMIT (a dash trata como interno)', linha('c:A6'));
conf(linha('b:11').sentido === 'saida' && linha('b:11').quem === 'HAYNAN OLIVEIRA DANTAS' && linha('b:11').centro === 'Pagamentos Haynan', 'PIX enviado: saida com recebedor e centro', linha('b:11'));
conf(linha('b:13').sentido === 'entrada', 'PIX recebido: entrada', linha('b:13').sentido);
conf(linha('b:14').sentido === 'entrada' && linha('b:15').sentido === 'saida', 'CDI entra e tarifa sai (sem subTipo, pela descricao)', [linha('b:14').sentido, linha('b:15').sentido]);
conf(linha('b:16').tipo === 'SECURED_CARD_DEPOSIT_OUT' && linha('b:16').sentido === 'saida', 'transferencia de limite: saida com o tipo preservado', linha('b:16'));
conf(!pedidos.some((p) => /startDate=2026-08-01&endDate=2026-10-31/.test(p)), 'pediu a API mes a mes, nunca a janela inteira de uma vez', pedidos.filter((p) => /statements/.test(p)).slice(0, 4));

console.log('\n2. COBRANCA PENDENTE QUE SUMIU DO EXTRATO');
CARTAO = CARTAO.filter((t) => t.id !== 'A4');
r = await chama('POST', '/api/cs/sync', 'dir', { de: '2026-10-01', ate: '2026-10-31' });
conf(linha('c:A4').status === 'SUMIU', 'a PENDING que nao veio mais vira SUMIU (sai do lucro na dash)', linha('c:A4').status);
conf(linha('c:A5').status === 'PROCESSED', 'a processada do mesmo mes continua', linha('c:A5').status);

console.log('\n3. QUEM LE O EXTRATO');
r = await chama('GET', '/api/cs/extrato', 'dir');
conf(r.status === 200 && r.j.escopo === 'full' && r.j.tx.length === n, 'diretor ve tudo', { s: r.status, e: r.j && r.j.escopo, n: r.j && r.j.tx && r.j.tx.length });
conf(r.j && r.j.tx && !('raw' in r.j.tx[0]), 'o JSON cru da API nao sai pra tela', r.j && Object.keys(r.j.tx[0] || {}));
conf(r.j && r.j.sync && r.j.sync.saldo === 7393.33 && r.j.sync.ok > 0, 'saldo da conta e hora da ultima sincronia vem junto', r.j && r.j.sync);
r = await chama('GET', '/api/cs/extrato', 'socio1');
conf(r.status === 200 && r.j.escopo === 'full', 'socio ve tudo', r.status);
r = await chama('GET', '/api/cs/extrato', 'gestor1');
const idsG = (r.j && r.j.tx || []).map((t) => t.id).sort();
conf(r.status === 200 && r.j.escopo === 'trafego', 'gestor de trafego recebe escopo trafego', r.status);
conf(idsG.includes('c:A1') && idsG.includes('c:A2') && idsG.includes('c:A5'), 'gestor ve a compra de anuncio e o IOF do cartao de anuncio', idsG);
conf(!idsG.some((id) => id.startsWith('b:')) && !idsG.includes('c:A3'), 'gestor NAO ve PIX, folha, fornecedor nem a ferramenta', idsG);
r = await chama('GET', '/api/cs/extrato', 'at_vend');
conf(r.status === 403, 'vendedor nao le', r.status);
r = await chama('GET', '/api/cs/extrato', 'afl_user');
conf(r.status === 403, 'afiliado nao le (o ContaSimples e da casa)', r.status);
r = await chama('GET', '/api/cs/extrato', null);
conf(r.status === 401, 'sem login nao le', r.status);

console.log('\n4. O MAPA DO BRUNO');
r = await chama('POST', '/api/cs/mapa', 'dir', { tipo: 'centro', chave: 'urgencias', valor: 'despesa' });
conf(r.status === 200 && r.j.mapa.centros.urgencias === 'despesa', 'diretor grava centro de custo -> linha', r.j);
r = await chama('POST', '/api/cs/mapa', 'dir', { tipo: 'tx', chave: 'b:11', valor: 'equipe' });
conf(r.status === 200 && r.j.mapa.tx['b:11'] === 'equipe' && r.j.mapa.centros.urgencias === 'despesa', 'excecao por transacao nao apaga a regra do centro', r.j);
r = await chama('POST', '/api/cs/mapa', 'dir', { tipo: 'centro', chave: 'urgencias', valor: '' });
conf(r.status === 200 && !('urgencias' in r.j.mapa.centros), 'valor vazio apaga a regra (volta ao automatico)', r.j);
r = await chama('POST', '/api/cs/mapa', 'dir', { tipo: 'centro', chave: 'x', valor: 'lucro' });
conf(r.status === 400, 'linha que nao existe e recusada', r.status);
r = await chama('POST', '/api/cs/mapa', 'dir', { tipo: 'vinc', chave: 'b:11', valor: 'lc123' });
conf(r.status === 200 && r.j.mapa.vinc['b:11'] === 'lc123', 'vinculo do PIX com o lancamento fica guardado', r.j);
r = await chama('POST', '/api/cs/mapa', 'gestor1', { tipo: 'centro', chave: 'x', valor: 'despesa' });
conf(r.status === 403, 'gestor nao muda o mapa', r.status);
r = await chama('POST', '/api/cs/sync', 'gestor1', {});
conf(r.status === 403, 'gestor nao forca sincronia', r.status);
r = await chama('POST', '/api/cs/sync', 'dir', { de: '2026-01-01', ate: '2026-10-31' });
conf(r.status === 400, 'janela maior que 3 meses e recusada (nao cabe numa requisicao)', r.status);

console.log('\n5. SEM CREDENCIAL');
const semCred = { ...env, CS_API_KEY: '', CS_API_SECRET: '' };
const r5 = await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev/api/cs/sync', { method: 'POST', headers: { authorization: 'Bearer ' + tok('dir'), 'content-type': 'application/json' }, body: '{}' }), semCred, ctx);
const j5 = await r5.json().catch(() => null);
conf(r5.status === 502 && j5 && /credencial/.test(j5.erro || ''), 'sem a chave no worker o sync diz o que falta', j5);

console.log('\n6. FRETE REAL DA PAYLOG (webhook v2)');
sq.prepare("INSERT INTO five_orders (order_id, offer_id, offer_qty, created_at, updated_at) VALUES ('PL-ORDFRETE1', 'k4', 1, 0, 0)").run();
const assina = (seg, corpo) => 'sha256=' + createHmac('sha256', seg).update(corpo).digest('hex');
const v2 = (ev, frete) => ({
  event: ev, event_label: ev, event_timestamp: '2026-10-20T10:00:00-03:00', idempotency_key: 'k' + Math.random(), cancelable: false,
  order: { pedido_id: 1, codigo_transacao: 'ORDFRETE1', referencia_externa: 'ORDFRETE1', plataforma: 'AfterPay Paylog', status: { code: 7, label: 'Enviado' }, motivo_parado: null,
    customer: { nome: 'C', cpf: '11122233344', email: null, telefone: '5521977776666', endereco: { logradouro: 'R', numero: '1', complemento: null, bairro: 'B', cidade: 'Mage', uf: 'RJ', cep: '25900000', pais: 'BR' } },
    items: [{ descricao: 'GlicoSix - 4 Meses (4 Frascos)', quantidade: 4, valor_unitario_cents: 49700, produto: { id: 816, nome: 'Glicosix' } }], frete_cents: frete },
  shipment: { tracking_code: '1', tracking_url: null, carrier: { code: 'jt', name: 'J&T' }, tracking_status: { code: 30, label: 'x' }, description: 'x', location: 'Mage/RJ', occurred_at: '2026-10-20T10:00:00-03:00', collection_address: null, delivery_proof: { image_url: null, signature_url: null, received_by: null, signatory: null, delivery_lat: null, delivery_lng: null } },
  meta: { webhook_version: 2, api_version: 2 },
});
const manda = async (obj) => {
  const corpo = JSON.stringify(obj);
  const st = (await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev/paylog/glico-six', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-event': obj.event, 'x-webhook-signature': assina('seg-normal', corpo) }, body: corpo }), env, ctx)).status;
  await drena();
  return st;
};
await manda(v2('order.created', 2070));
const fr = () => sq.prepare("SELECT frete_real f FROM five_orders WHERE order_id = 'PL-ORDFRETE1'").get().f;
conf(Math.abs(fr() - 20.70) < 0.001, 'order.created preenche o frete vazio', fr());
await manda(v2('order.preparing', 1957));
conf(Math.abs(fr() - 19.57) < 0.001, 'a nova cotacao (preparing) grava por cima', fr());
await manda(v2('order.blocked', 2070));
conf(Math.abs(fr() - 19.57) < 0.001, 'um order.blocked atrasado NAO volta pra primeira cotacao', fr());
await manda(v2('shipment.in_transit', 0));
conf(Math.abs(fr() - 19.57) < 0.001, 'evento sem frete nao apaga o que ja tem', fr());

console.log('\n' + (ruim ? ruim + ' FALHA(S), ' : 'TUDO PASSOU, ') + ok + ' ok');
process.exit(ruim ? 1 : 0);
