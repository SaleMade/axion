// PAGAMENTO PARCIAL COM DIA ESCOLHIDO, COMPROVANTE E FRASE PRONTA DO COBRADOR (17/11/2026). Roda o
// worker inteiro (bundle do wrangler) contra um D1 de mentira e prova:
//
//  1) a parcela entra no DIA que o cobrador escolheu ("Ontem", o calendario), nunca no futuro;
//  2) parcela + proximo pagamento (agend) + comprovante (comentario com imagem) numa gravacao so;
//  3) "pagou tudo" com dia escolhido carimba o pago naquele dia (pago_quando);
//  4) quitar o resto de um parcial com dia escolhido: pago no dia, sem parcela de "fechou a conta";
//  5) a ficha do app traz o carimbo do comentario (o lapis), quem pode editar, o link da imagem
//     assinado e se ele pode mexer nas frases prontas;
//  6) o cobrador da casa grava as frases prontas; o vendedor continua sem poder.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-pagamento-parcial-rota.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-pagamento-parcial-rota.mjs <bundle>/worker.js'); process.exit(2); }
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
const usuarios = [['dir', 'Diretor', 'diretor'], ['kev', 'Kevin Marques', 'atendente'], ['bry', 'Bryan Amorim', 'cobrador']];
for (const [id, nome, role] of usuarios) sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role);
const TK = { dir: 'd'.repeat(64), kev: 'b'.repeat(64), bry: 'c'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, agoraS + 86400);

const p2 = (n) => String(n).padStart(2, '0');
// o dia em Brasilia, N dias atras (negativo = no futuro), como a tela manda: 'AAAA-MM-DD'
const diaBr = (diasAtras) => { const d = new Date(Date.now() - diasAtras * 86400000 - 3 * 3600000); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); };
const dataBr = (diasAtras) => { const d = new Date(Date.now() - diasAtras * 86400000 - 3 * 3600000); return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(); };
const brHist = (diasAtras) => { const d = new Date(Date.now() - diasAtras * 86400000 - 3 * 3600000); return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); };
const idMs = (dias) => String(Date.now() - dias * 86400000);
const L1 = idMs(5), L2 = idMs(6), L3 = idMs(7), L4 = idMs(8), L5 = idMs(9);
const entregue = { col: 'Cobrança', spg: 'Pendente', at: 'kev', cob: 'bry', hist: [{ from: 'Enviado', to: 'Entregue', time: brHist(2) }] };
const estado = {
  coment_prontos: ['Cliente não atendeu'],
  leads: [
    { id: L1, nome: 'Ana Parte Ontem', wa: '31977770001', vl: 500, ...entregue },
    { id: L2, nome: 'Bia Tudo Ontem', wa: '31977770002', vl: 297, ...entregue },
    { id: L3, nome: 'Caio Quita Resto', wa: '31977770003', vl: 497, ...entregue,
      pagamentos: [{ ts: agoraS - 5 * 86400, data: dataBr(5), valor: 200, who: 'bry', obs: 'parcial' }], spg: 'Parcial' },
    { id: L4, nome: 'Duda Futuro', wa: '31977770004', vl: 397, ...entregue },
    { id: L5, nome: 'Edu Comentarios', wa: '31977770005', vl: 397, ...entregue,
      comments: [
        { who: 'bry', tx: 'liguei, pediu pra voltar', time: brHist(1) },
        { who: 'kev', tx: 'cliente gente boa', time: brHist(2) },
        { who: 'bry', tx: 'comprovante', time: brHist(3), kind: 'image', url: 'https://x/api/arquivo/comprovante%2F' + idMs(9) + '%2Fa.png', mime: 'image/png' },
      ] },
  ],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-parcial.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB, ARQ_SEGREDO: 'segredo-de-teste' };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const chama = async (tk, path, body) => {
  const h = {};
  if (tk) h.authorization = 'Bearer ' + tk;
  if (body) h['content-type'] = 'application/json';
  h['x-sw-maquina'] = 'm1'; h['x-sw-versao'] = '1.26.23';
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.clone().json(); } catch (_) { d = {}; }
  return { st: r.status, d, txt: await r.text().catch(() => '') };
};
const ler = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data);
const lead = (id) => (ler().leads || []).find((l) => String(l.id) === String(id));
const diaDoMs = (ms) => { const d = new Date(Number(ms) - 3 * 3600000); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); };

_log('\nPARCELA NO DIA ESCOLHIDO, COM O PROXIMO PAGAMENTO E O COMPROVANTE\n');
const prox = diaBr(-13) + 'T09:00';
let r = await chama(TK.bry, '/api/lead/' + L1, { patch: {
  pagamento_add: { valor: 250, quando: diaBr(1), obs: 'parcial' }, agend: prox,
  comment_add: { kind: 'image', url: 'https://x/api/arquivo/comprovante%2F' + L1 + '%2Fb.png', mime: 'image/png', file_name: 'b.png', tx: 'Pagou R$ 250,00' },
  antes: { spg: 'Pendente', col: 'Cobrança' },
} });
let l = lead(L1);
vale('o cobrador grava a parcela', r.st === 200 && r.d.ok && Number(r.d.parcelas) === 1, r.st + ' ' + JSON.stringify(r.d).slice(0, 120));
vale('a parcela entra com a data de ONTEM', l.pagamentos && l.pagamentos[0] && l.pagamentos[0].data === dataBr(1), JSON.stringify(l.pagamentos));
vale('e o carimbo da parcela e de ontem', l.pagamentos && diaDoMs(l.pagamentos[0].ts * 1000) === diaBr(1), String(l.pagamentos && l.pagamentos[0].ts));
vale('o pedido vira Parcial e fica na Cobranca', l.spg === 'Parcial' && l.col === 'Cobrança', l.spg + ' / ' + l.col);
vale('o proximo pagamento vira o retorno (agend)', l.agend === prox, l.agend);
vale('o comprovante entra como comentario com imagem', (l.comments || [])[0] && l.comments[0].kind === 'image' && /b\.png/.test(l.comments[0].url) && l.comments[0].who === 'bry', JSON.stringify((l.comments || [])[0]));
vale('parcial nao carimba pago', !l.pago_ts, String(l.pago_ts));

_log('\nPAGOU TUDO, ONTEM\n');
r = await chama(TK.bry, '/api/lead/' + L2, { patch: { spg: 'Pago', valor_neg: 297, col: 'Pagos', pago_quando: diaBr(1), antes: { spg: 'Pendente', col: 'Cobrança' } } });
l = lead(L2);
vale('marca pago', r.st === 200 && l.spg === 'Pago' && l.col === 'Pagos', r.st + ' ' + l.spg + ' ' + l.col);
vale('o pago fica no dia de ontem', diaDoMs(l.pago_ts) === diaBr(1), new Date(l.pago_ts).toISOString());
vale('sem parcela inventada (nao tinha parcial)', !Array.isArray(l.pagamentos) || l.pagamentos.length === 0, JSON.stringify(l.pagamentos));

_log('\nQUITA O RESTO DE UM PARCIAL, COM O DIA\n');
r = await chama(TK.bry, '/api/lead/' + L3, { patch: {
  pagamento_add: { valor: 297, quando: diaBr(2), obs: 'quitou' }, spg: 'Pago', valor_neg: 497, col: 'Pagos', antes: { spg: 'Parcial', col: 'Cobrança' },
} });
l = lead(L3);
vale('fecha pago', r.st === 200 && l.spg === 'Pago' && l.col === 'Pagos', r.st + ' ' + l.spg);
vale('duas parcelas, a soma e o pedido inteiro', (l.pagamentos || []).length === 2 && l.pagamentos.reduce((s, p) => s + p.valor, 0) === 497, JSON.stringify(l.pagamentos));
vale('o pago fica no dia escolhido (anteontem)', diaDoMs(l.pago_ts) === diaBr(2), new Date(l.pago_ts).toISOString());
vale('as parcelas ficam em ordem de data', (l.pagamentos || []).every((p, i, a) => i === 0 || a[i - 1].ts <= p.ts), JSON.stringify((l.pagamentos || []).map((p) => p.data)));

_log('\nDIA NO FUTURO OU INVALIDO VIRA HOJE\n');
r = await chama(TK.bry, '/api/lead/' + L4, { patch: { pagamento_add: { valor: 100, quando: diaBr(-3) }, antes: { spg: 'Pendente', col: 'Cobrança' } } });
l = lead(L4);
vale('futuro: a parcela entra com a data de hoje', l.pagamentos && l.pagamentos[0].data === dataBr(0), JSON.stringify(l.pagamentos));
r = await chama(TK.bry, '/api/lead/' + L4, { patch: { pagamento_add: { valor: 50, quando: '2026-02-31' } } });
l = lead(L4);
vale('data que nao existe: hoje', l.pagamentos && l.pagamentos[1] && l.pagamentos[1].data === dataBr(0), JSON.stringify(l.pagamentos));
r = await chama(TK.bry, '/api/lead/' + L4, { patch: { pagamento_add: { valor: 10, quando: diaBr(200) } } });
l = lead(L4);
vale('mais de 120 dias atras: hoje', l.pagamentos && l.pagamentos[2] && l.pagamentos[2].data === dataBr(0), JSON.stringify(l.pagamentos && l.pagamentos[2]));
r = await chama(TK.kev, '/api/lead/' + L4, { patch: { pagamento_add: { valor: 10, quando: diaBr(1) } } });
vale('vendedor nao registra parcela', (lead(L4).pagamentos || []).length === 3 && (r.st !== 200 || (r.d.negados || []).includes('pagamento_add')), r.st + ' ' + JSON.stringify(r.d.negados));

_log('\nA FICHA DO APP: LAPIS DO COMENTARIO, LINK ASSINADO, FRASES PRONTAS\n');
r = await chama(TK.bry, '/api/swweb/cobranca/pedido?id=' + L5);
const f = (r.d.pedidos || [])[0] || {};
const cs = f.comentarios || [];
vale('a ficha abre', r.st === 200 && cs.length === 3, r.st + ' ' + cs.length);
vale('cada comentario traz o carimbo (time e who) do lapis', cs.every((c) => c.time && c.who), JSON.stringify(cs.map((c) => [c.time, c.who])));
vale('o cobrador edita o que ELE escreveu', cs[0].meu === true && cs[2].meu === true, JSON.stringify(cs.map((c) => c.meu)));
vale('e nao o do vendedor', cs[1].meu === false, String(cs[1].meu));
vale('a imagem do comentario sai com link assinado', /\?exp=\d+&sig=[0-9a-f]+/.test(cs[2].url || ''), cs[2].url);
vale('o cobrador da casa pode mexer nas frases prontas', r.d.podeProntos === true, String(r.d.podeProntos));
r = await chama(TK.dir, '/api/swweb/cobranca/pedido?id=' + L5);
vale('a direcao edita qualquer comentario', ((r.d.pedidos || [])[0] || {}).comentarios.every((c) => c.meu === true), '');
r = await chama(TK.bry, '/api/swweb/cobranca');
vale('o quadro tambem diz que ele pode mexer nas frases', r.st === 200 && r.d.podeProntos === true, r.st + ' ' + r.d.podeProntos);

_log('\nO LAPIS: EDITAR O COMENTARIO PELO APP\n');
r = await chama(TK.bry, '/api/lead/' + L5, { patch: { comment_set: { time: cs[0].time, who: cs[0].who, tx: 'liguei, volta dia 20' } } });
const c0 = (lead(L5).comments || [])[0];
vale('o comentario muda e fica marcado editado', r.st === 200 && c0.tx === 'liguei, volta dia 20' && c0.editado === true, r.st + ' ' + JSON.stringify(c0));

_log('\nFRASES PRONTAS\n');
r = await chama(TK.bry, '/api/coment-prontos', { lista: ['Cliente não atendeu', 'Boleto enviado, paga dia 30'] });
vale('o cobrador grava a lista', r.st === 200 && (ler().coment_prontos || []).length === 2, r.st + ' ' + JSON.stringify(ler().coment_prontos));
r = await chama(TK.kev, '/api/coment-prontos', { lista: ['apagou tudo'] });
vale('o vendedor continua sem poder', r.st === 403 && (ler().coment_prontos || []).length === 2, r.st + ' ' + JSON.stringify(ler().coment_prontos));

_log('\n' + ok + ' ok, ' + falhas.length + ' falha(s)' + (falhas.length ? ': ' + falhas.join(' | ') : ''));
process.exit(falhas.length ? 1 : 0);
