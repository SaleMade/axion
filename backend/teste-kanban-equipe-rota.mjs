// O VENDEDOR VE O KANBAN DA EQUIPE, SO LEITURA (19/11/2026, pedido do Bruno: "eu gostaria que meus
// vendedores conseguissem ver todo o Kanban por completo (...) Claro, eles nao vao poder mexer ou
// editar nada dos outros"). Roda o worker inteiro (bundle do wrangler) contra um D1 de mentira e prova:
//
//  1) /api/kanban/equipe entrega ao vendedor os pedidos da CASA que nao sao dele (de colega e sem
//     vendedor) e nunca pedido de afiliado nem o dele (o dele ja vem no /api/state);
//  2) o /api/state do vendedor NAO mudou: continua so com os pedidos dele (as outras telas contam com isso);
//  3) no pedido do colega nada grava: comentario (caminho curto e o longo), etiqueta, observacao,
//     retorno; e o estado fica igual byte a byte;
//  4) no pedido dele continua gravando; cobrador e direcao gravam em qualquer pedido da casa;
//  5) afiliado e gestor de trafego nao entram na rota.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-kanban-equipe-rota.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-kanban-equipe-rota.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function stmt(sql, args = []) {
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  };
}
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (l) => { const out = []; for (const s of (l || [])) out.push(/^\s*SELECT/i.test(String(s.__sql || '')) ? await s.all() : await s.run()); return out; },
  exec: async (s) => sq.exec(s),
};
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)); };
const _log = console.log;
console.log = () => {};

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

const agoraS = Math.floor(Date.now() / 1000);
const usuarios = [
  ['dir', 'Diretor', 'diretor', null], ['kev', 'Kevin Marques', 'atendente', null], ['gui', 'Guilherme', 'atendente', null],
  ['bry', 'Bryan Amorim', 'cobrador', null], ['gt', 'Gestor', 'gestor', null], ['afl1', 'Afiliado', 'afiliado', 'afl_x'],
];
for (const [id, nome, role, afl] of usuarios) sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role, afl);
const TK = { dir: 'd'.repeat(64), kev: 'b'.repeat(64), gui: 'e'.repeat(64), bry: 'c'.repeat(64), gt: 'f'.repeat(64), afl1: 'a'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, agoraS + 86400);

const idMs = (dias) => String(Date.now() - dias * 86400000);
const DO_KEV = idMs(3), DO_GUI = idMs(4), SEM_DONO = idMs(5), DE_AFL = idMs(6), DO_GUI2 = idMs(7);
const base = { col: 'Enviado', spg: 'Pendente', data: '15/11', vl: 497, tags: [], comments: [] };
const estado = {
  tags: [{ id: 'tg1', name: 'Urgente', color: '#f00' }],
  leads: [
    { id: DO_KEV, nome: 'Cliente do Kevin', at: 'kev', ...base },
    { id: DO_GUI, nome: 'Cliente do Guilherme', at: 'gui', cob: 'bry', ...base, comments: [{ who: 'gui', tx: 'liguei', time: '15/11 10:00' }] },
    { id: SEM_DONO, nome: 'Reenvio sem vendedor', at: '', ...base },
    { id: DE_AFL, nome: 'Pedido de afiliado', at: 'afl1', afl: 'afl_x', ...base },
    { id: DO_GUI2, nome: 'Outro do Guilherme', at: 'gui', ...base, col: 'Pagos', spg: 'Pago' },
  ],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-kanban-equipe.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB, ARQ_SEGREDO: 'segredo-de-teste' };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const chama = async (tk, path, body) => {
  const h = {};
  if (tk) h.authorization = 'Bearer ' + tk;
  if (body) h['content-type'] = 'application/json';
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.clone().json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
const bruto = () => sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data;
const ler = () => JSON.parse(bruto());
const lead = (id) => (ler().leads || []).find((l) => String(l.id) === String(id));
const ids = (arr) => (Array.isArray(arr) ? arr : []).map((l) => String(l.id)).sort();

_log('\nA ROTA DO QUADRO DA EQUIPE\n');
let r = await chama(TK.kev, '/api/kanban/equipe');
vale('o vendedor entra na rota', r.st === 200 && r.d.ok, String(r.st));
vale('leva os pedidos de colega e o sem vendedor', JSON.stringify(ids(r.d.leads)) === JSON.stringify([DO_GUI, SEM_DONO, DO_GUI2].sort()), JSON.stringify(ids(r.d.leads)));
vale('nunca o pedido de afiliado', !ids(r.d.leads).includes(DE_AFL));
vale('nem o dele (esse ja vem no estado)', !ids(r.d.leads).includes(DO_KEV));
vale('o pedido vai inteiro (comentario, cobrador)', (() => { const g = (r.d.leads || []).find((l) => String(l.id) === DO_GUI); return g && g.cob === 'bry' && g.comments && g.comments.length === 1; })());
vale('vem com a versao do estado', Number(r.d.version) === 1, String(r.d.version));
r = await chama(TK.afl1, '/api/kanban/equipe');
vale('afiliado nao entra', r.st === 403, String(r.st));
r = await chama(TK.gt, '/api/kanban/equipe');
vale('gestor de trafego nao entra', r.st === 403, String(r.st));
r = await chama(null, '/api/kanban/equipe');
vale('sem login nao entra', r.st === 401, String(r.st));

_log('\nO ESTADO DO VENDEDOR NAO MUDOU\n');
r = await chama(TK.kev, '/api/state');
vale('o /api/state do vendedor continua so com o pedido dele', JSON.stringify(ids(r.d.data && r.d.data.leads)) === JSON.stringify([DO_KEV]), JSON.stringify(ids(r.d.data && r.d.data.leads)));

_log('\nNO PEDIDO DO COLEGA NADA GRAVA\n');
const antes = bruto();
const tentativas = [
  ['comentario (caminho curto)', { comment_add: { tx: 'xereta', time: '19/11 10:00' } }],
  ['apagar comentario do colega', { comment_del: { who: 'gui', time: '15/11 10:00' } }],
  ['editar comentario do colega', { comment_set: { who: 'gui', time: '15/11 10:00', tx: 'mudei' } }],
  ['etiqueta', { tags: ['tg1'] }],
  ['observacao', { obs: 'mexi' }],
  ['retorno', { agend: '2026-12-01T09:00' }],
  ['comentario junto de outro campo (caminho longo)', { comment_add: { tx: 'x' }, obs: 'y' }],
  ['endereco', { end: 'Rua Nova', num: '1' }],
];
for (const [nome, patch] of tentativas) {
  r = await chama(TK.kev, '/api/lead/' + DO_GUI, { patch });
  vale('recusa: ' + nome, r.st === 403 && r.d.ok === false && /outro vendedor/.test(String(r.d.error || '')), r.st + ' ' + String(r.d.error || ''));
}
r = await chama(TK.kev, '/api/lead/' + SEM_DONO, { patch: { comment_add: { tx: 'no sem dono' } } });
vale('recusa no pedido sem vendedor tambem', r.st === 403, String(r.st));
vale('o estado ficou igual byte a byte', bruto() === antes);

_log('\nNO PEDIDO DELE, E PRA QUEM COBRA, CONTINUA IGUAL\n');
r = await chama(TK.kev, '/api/lead/' + DO_KEV, { patch: { comment_add: { tx: 'no meu', time: '19/11 11:00' } } });
vale('o vendedor comenta no pedido dele', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
r = await chama(TK.kev, '/api/lead/' + DO_KEV, { patch: { tags: ['tg1'], obs: 'anotei' } });
vale('e etiqueta e anota no dele', r.st === 200 && (lead(DO_KEV).tags || []).includes('tg1') && lead(DO_KEV).obs === 'anotei', r.st + ' ' + JSON.stringify(lead(DO_KEV).tags));
r = await chama(TK.bry, '/api/lead/' + DO_GUI, { patch: { comment_add: { tx: 'cobrando', time: '19/11 12:00' } } });
vale('o cobrador comenta no pedido de qualquer vendedor', r.st === 200 && (lead(DO_GUI).comments || []).some((c) => c.tx === 'cobrando'), String(r.st));
r = await chama(TK.dir, '/api/lead/' + DO_GUI, { patch: { tags: ['tg1'] } });
vale('a direcao etiqueta qualquer pedido', r.st === 200 && (lead(DO_GUI).tags || []).includes('tg1'), String(r.st));
r = await chama(TK.gui, '/api/lead/' + DO_GUI, { patch: { obs: 'meu cliente' } });
vale('e o dono (Guilherme) segue mexendo no dele', r.st === 200 && lead(DO_GUI).obs === 'meu cliente', String(r.st));

_log('');
console.log = _log;
if (falhas.length) { _log(falhas.length + ' FALHA(S): ' + falhas.join(' | ')); process.exit(1); }
_log('  ' + ok + ' conferencias, todas passaram.');
