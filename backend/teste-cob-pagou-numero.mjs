// JA PAGOU? E DE QUAL NUMERO E O CLIENTE? (14/11/2026). Roda o worker inteiro (bundle do wrangler)
// contra um D1 de mentira e prova as duas metades do pedido do Bruno daquele dia:
//
//  1. "teve varios pedidos que foram pagos e (...) a automacao (...) falando que o pedido ainda nao foi
//     pago foi disparada". O "nao pagou" so sai pra quem esta esquecido: sem comprovante no pedido, sem
//     foto/documento do cliente desde que o pedido saiu, sem ninguem da equipe falando com ele depois da
//     entrega, sem anotacao depois da entrega, sem retorno marcado pra hoje ou depois. As outras (saiu,
//     retirada, boas-vindas) saem sem a linha do valor quando ha sinal de pagamento. E na hora de PEGAR o
//     servidor confere de novo.
//  2. "quando ele troca de numero de cobranca para outro, ele nao visualiza nenhuma das cobrancas". O
//     quadro do app diz de qual numero e cada cliente (numCli) e onde ele ja falou (falou); o cobrador
//     passa o cliente pra outro numero (POST /api/swweb/cobranca/numero), o link passa a abrir o numero
//     novo e as automaticas so mudam de numero depois que houver conversa nele.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-cob-pagou-numero.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-cob-pagou-numero.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER, versao TEXT)');
sq.exec('CREATE TABLE IF NOT EXISTS swweb_auto (k TEXT PRIMARY KEY, tipo TEXT, nk TEXT, fone TEXT, pedido TEXT, nome TEXT, status TEXT,'
  + ' n INTEGER DEFAULT 0, tent INTEGER DEFAULT 0, criado INTEGER, pego_ts INTEGER, feito_ts INTEGER, maquina TEXT, por TEXT, motivo TEXT)');
for (const x of ['ALTER TABLE wa_messages ADD COLUMN mundo TEXT', 'ALTER TABLE users ADD COLUMN afiliado_id TEXT', 'ALTER TABLE users ADD COLUMN archived INTEGER DEFAULT 0']) { try { sq.exec(x); } catch (_) {} }
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
// O RELOGIO E DO TESTE: sabado 14/11/2026 10:00 de Brasilia (13:00 UTC).
const T0 = Date.UTC(2026, 10, 14, 13, 0, 0);
let AGORA = T0;
Date.now = () => AGORA;
const _log = console.log;
const logs = [];
console.log = (...a) => { logs.push(a.join(' ')); };

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + String(detalhe).slice(0, 200) : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + String(detalhe).slice(0, 500) : '')); }
};

const S = () => Math.floor(AGORA / 1000);
const usuarios = [
  ['dir', 'Diretor', 'diretor'], ['bry', 'Bryan Amorim', 'cobrador'], ['hay', 'Haynan', 'cobrador'], ['kev', 'Kevin Marques', 'atendente'],
];
for (const [id, nome, role] of usuarios) {
  sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role);
  sq.prepare('UPDATE users SET afiliado_id=NULL, archived=0 WHERE id=?').run(id);
}
const TK = { dir: 'd'.repeat(64), bry: 'b'.repeat(64), hay: 'c'.repeat(64), kev: 'e'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, S() + 30 * 86400);

const NK_BRY = '1127335679', NK_BRY2 = '1166632248', NK_HAY = '1591980514';
const I_BRY = 'ax_bry_27335679', I_BRY2 = 'ax_bry_66632248', I_HAY = 'ax_hay_91980514', I_KEV = 'ax_kev_95554444';
const H = 3600000, DIA = 86400000;
const iso = (msAtras) => new Date(T0 - msAtras).toISOString();
const hist = (de, para, msAtras) => ({ from: de, to: para, who: 'five', time: iso(msAtras) });
// o comentario da dash: "DD/MM HH:MM" em hora de Brasilia
const ddmm = (msAtras) => { const d = new Date(T0 - msAtras - 3 * H); const p = (n) => String(n).padStart(2, '0'); return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); };
const COMPROV = 'https://axion-api.axion-dash.workers.dev/api/arquivo/comprovante%2F3002%2Fx.png';
const base = { vl: 497, mod: 'entrega', at: 'kev', cob: 'bry', end: 'Rua das Flores', num: '120', bairro: 'Centro', cidade: 'Betim', uf: 'mg', cep: '32600-000', link: 'https://checkout.payt.com.br/abc123' };
// entregue ha 50 h: dia seguinte, dentro das 72 h, e sem o "entregue" (ja passou das 30 h)
const cob50 = (id, nome, extra) => ({ ...base, id, nome, wa: '(31) 90000-' + id, col: 'Cobrança', track: '88803000000' + id, hist: [hist('Preparando', 'Enviado', 5 * DIA), hist('Rota de Entrega', 'Cobrança', 50 * H)], ...(extra || {}) });
const estado = {
  wa_statuses: [{ id: 'st_uso', label: 'Em uso', papel: 'em_uso' }],
  chips: [
    { id: 'c1', num: '(11) 92733-5679', at: 'bry', em_uso: true, st: 'ativo' },
    { id: 'c2', num: '(15) 99198-0514', at: 'hay', em_uso: true, st: 'ativo' },
    { id: 'c3', num: '(31) 95555-4444', at: 'kev', em_uso: true, st: 'ativo' },
    { id: 'c4', num: '(11) 96663-2248', at: 'bry', em_uso: true, st: 'ativo' },
  ],
  pressels: [],
  leads: [
    cob50('3001', 'Ana Limpa'),
    cob50('3002', 'Olimpio Anexo', { comments: [{ who: 'kev', tx: '', time: ddmm(20 * H), kind: 'image', url: COMPROV, mime: 'image/png' }] }),
    cob50('3003', 'Clara Foto Pro Vendedor'),
    cob50('3004', 'Dora Foto Velha'),
    cob50('3005', 'Ivan Combinou'),
    cob50('3006', 'Vera Vendedor Falou'),
    cob50('3007', 'Lia Anotou Depois', { comments: [{ who: 'bry', tx: 'Chamei o lead, aguardando resposta.', time: ddmm(40 * H) }] }),
    cob50('3008', 'Mel Anotou Antes', { comments: [{ who: 'bry', tx: 'Avisei que esta chegando', time: ddmm(60 * H) }] }),
    cob50('3009', 'Nina Retorno Hoje', { agend: '2026-11-14T09:00' }),
    cob50('3010', 'Otto Retorno Ontem', { agend: '2026-11-13T09:00' }),
    cob50('3011', 'Paulo Pago', { col: 'Pagos', spg: 'Pago', pago_ts: T0 - 3 * DIA }),
    { ...base, id: '3020', nome: 'Sara Saiu', wa: '(31) 90000-3020', col: 'Rota de Entrega', track: '888030000003020', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    { ...base, id: '3021', nome: 'Saulo Pagou Pix', wa: '(31) 90000-3021', col: 'Rota de Entrega', track: '888030000003021', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)],
      comments: [{ who: 'kev', tx: 'pix', time: ddmm(1 * H), kind: 'image', url: COMPROV }] },
    // o cobrador ja avisou que saiu: a automatica do "saiu" nao repete (a pagina nem sempre ve a mensagem dele)
    { ...base, id: '3024', nome: 'Zeca Saiu Ja Avisado', wa: '(31) 90000-3024', col: 'Rota de Entrega', track: '888030000003024', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    { ...base, id: '3022', nome: 'Rita Retirada Foto', wa: '(31) 90000-3022', col: 'Retirada', track: 'AP111111111BR', ship: 'READY_FOR_PICKUP', hist: [hist('Enviado', 'Retirada', 3 * H)] },
    { ...base, id: '3023', nome: 'Rui Retirada', wa: '(31) 90000-3023', col: 'Retirada', track: 'AP222222222BR', ship: 'READY_FOR_PICKUP', hist: [hist('Enviado', 'Retirada', 3 * H)] },
    { ...base, id: '3030', nome: 'Tais Pagou Antes', wa: '(31) 90000-3030', col: 'A Enviar', comments: [{ who: 'kev', tx: '', time: ddmm(1 * H), kind: 'image', url: COMPROV }] },
    { ...base, id: '3031', nome: 'Tito Nao Pagou', wa: '(31) 90000-3031', col: 'A Enviar' },
    // OS NUMEROS: o Bryan com dois numeros Em uso
    { ...base, id: '4001', nome: 'Beto Fala No 5679', wa: '(31) 90000-4001', col: 'Rota de Entrega', track: '888030000004001', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    { ...base, id: '4002', nome: 'Caio Nunca Chamou', wa: '(31) 90000-4002', col: 'Enviado', track: '888030000004002', hist: [hist('Preparando', 'Enviado', 1 * DIA)] },
    { ...base, id: '4003', nome: 'Duda Fala No 2248', wa: '(31) 90000-4003', col: 'Cobrança', track: '888030000004003', hist: [hist('Rota de Entrega', 'Cobrança', 3 * H)] },
    { ...base, id: '4004', nome: 'Eli Marcado No 2248', wa: '(31) 90000-4004', col: 'Enviado', track: '888030000004004', hist: [hist('Preparando', 'Enviado', 1 * DIA)] },
  ],
};
const gravaEstado = () => {
  const v = (sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get() || { version: 0 }).version;
  sq.prepare('INSERT OR REPLACE INTO dashboard_state (id,data,version) VALUES (1,?,?)').run(JSON.stringify(estado), v + 1);
};
gravaEstado();
let mid = 0;
const msg = (phone, inst, dir, body, segAtras, type) => sq.prepare('INSERT INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts, mundo) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('m' + (++mid), phone, inst, dir, type || 'text', body, '', S() - segAtras, '');
// todo mundo da parte 1 ja falou com o Bryan ha 6 dias (e foi respondido)
for (const n of ['3001', '3002', '3003', '3004', '3005', '3006', '3007', '3008', '3009', '3010', '3011', '3020', '3021', '3022', '3023', '3024', '4001']) {
  msg('553190000' + n, I_BRY, 'in', 'oi', 6 * 86400);
  msg('553190000' + n, I_BRY, 'out', 'Boa tarde', 6 * 86400 - 60);
}
msg('5531900003003', I_KEV, 'in', '', 30 * 3600, 'image');            // comprovante pro VENDEDOR, depois que saiu
msg('5531900003004', I_BRY, 'in', '', 12 * 86400, 'image');            // foto de ANTES de o pedido sair
msg('5531900003005', I_BRY, 'out', 'Pode passar o cartao amanha as 10h', 40 * 3600);   // o cobrador combinou
msg('5531900003006', I_KEV, 'out', 'Segue a chave Pix', 40 * 3600);    // o vendedor cobrou
msg('5531900003022', I_BRY, 'in', '', 2 * 3600, 'image');               // foto na retirada
msg('5531900003024', I_BRY, 'out', 'Seu pedido saiu pra entrega hoje!', 3600);   // o cobrador avisou
// as boas-vindas: acabaram de chamar
msg('5531900003030', I_BRY, 'in', 'Olá! Quero acompanhar o meu pedido.', 200);
msg('5531900003031', I_BRY, 'in', 'Olá! Quero acompanhar o meu pedido.', 200);
// a Duda escreveu no SEGUNDO numero do Bryan
msg('5531900004003', I_BRY2, 'in', 'oi', 86400);
msg('5531900004003', I_BRY2, 'out', 'Boa tarde', 86400 - 60);
// a Eli clicou no link e o rodizio marcou o 2248, mas ela ainda nao escreveu
sq.exec('CREATE TABLE IF NOT EXISTS cob_num_cli (k TEXT PRIMARY KEY, nk TEXT NOT NULL, at TEXT, origem TEXT, criado INTEGER, mexido INTEGER)');
sq.prepare("INSERT INTO cob_num_cli (k, nk, at, origem, criado, mexido) VALUES ('3100004004', ?, 'bry', 'rodizio', ?, ?)").run(NK_BRY2, S() - 3600, S() - 3600);

const aluga = (nk, quem, maq) => sq.prepare('INSERT OR REPLACE INTO swweb_uso (nk,user_id,nome,maquina,desde,ate,versao) VALUES (?,?,?,?,?,?,?)').run(nk, quem, quem, maq, S() - 600, S() + 120, '1.26.20');
const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-cob-pagou-numero.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const renova = () => { aluga(NK_BRY, 'bry', 'mb'); aluga(NK_BRY2, 'bry', 'mb'); aluga(NK_HAY, 'hay', 'mh'); };
const chama = async (tk, path, body, maquina) => {
  renova();
  const h = { authorization: 'Bearer ' + tk };
  if (body) h['content-type'] = 'application/json';
  if (maquina) { h['x-sw-maquina'] = maquina; h['x-sw-versao'] = '1.26.20'; }
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
const itens = async () => (await chama(TK.bry, '/api/swweb/auto?nks=' + NK_BRY + ',' + NK_BRY2, null, 'mb')).d.itens || [];
const previa = async () => (await chama(TK.dir, '/api/cob/auto')).d.fila || [];
const de = (lista, ped, tipo) => (lista || []).find((x) => String(x.pedido) === String(ped) && (!tipo || x.tipo === tipo));
// a previa da dash nao traz o pedido: casa pelo primeiro nome (todos diferentes neste teste)
const naPrevia = (lista, ped, tipo) => { const pn = estado.leads.find((l) => l.id === ped).nome.split(' ')[0]; return (lista || []).find((x) => String(x.nome || '').split(' ')[0] === pn && (!tipo || x.tipo === tipo)); };
const linha = (k) => sq.prepare('SELECT * FROM swweb_auto WHERE k=?').get(k);
const pega = async (it) => (await chama(TK.bry, '/api/swweb/auto/pega', { k: it.k, chaves: it.chaves, nk: it.nk, tipo: it.tipo, fone: it.fone, pedido: it.pedido, nome: it.nome }, 'mb')).d;
const lead = (id) => estado.leads.find((l) => l.id === id);

await chama(TK.dir, '/api/cob/auto', { rec: true, recr: true, pos: true, sai: true, ent: true, ret: true, nach: true, npg: true, atr: true, pag: true });

_log('\n1. O "NAO PAGOU" SO PRA QUEM ESTA ESQUECIDO\n');
let fila = await previa();
const npg = (id) => naPrevia(fila, id, 'naopagou');
vale('entregue ontem, ninguem falou, sem comprovante: sai o lembrete (o caso normal continua)', !!npg('3001') && /Passando pra lembrar do pagamento/.test(npg('3001').textos[0]), npg('3001') && npg('3001').textos[0].slice(0, 60));
vale('comprovante ANEXADO no pedido (o caso do Olimpio): nao sai', !npg('3002'), '');
vale('o cliente mandou foto pro VENDEDOR depois que o pedido saiu: nao sai', !npg('3003'), '');
vale('foto de ANTES de o pedido sair nao conta como comprovante: sai', !!npg('3004'), '');
vale('o cobrador ja combinou com ele depois da entrega (o caso do Ivan): nao sai, lido do servidor', !npg('3005'), '');
vale('o vendedor cobrou depois da entrega: nao sai (qualquer numero nosso)', !npg('3006'), '');
vale('anotacao no pedido depois da entrega: nao sai', !npg('3007'), '');
vale('anotacao de ANTES da entrega nao segura: sai', !!npg('3008'), '');
vale('retorno marcado pra HOJE (mesmo com a hora passada): nao sai', !npg('3009'), '');
vale('retorno de ONTEM (esquecido): sai', !!npg('3010'), '');
vale('pedido pago: nao sai', !npg('3011'), '');

_log('\n2. AS OUTRAS SAEM SEM A LINHA DO VALOR QUANDO HA SINAL DE PAGAMENTO\n');
const sai1 = naPrevia(fila, '3020', 'saiu'), sai2 = naPrevia(fila, '3021', 'saiu');
vale('saiu pra entrega sem sinal: leva "Valor a pagar"', !!sai1 && /Valor a pagar depois de receber: R\$ 497,00/.test(sai1.textos[0]), sai1 && sai1.textos[0].slice(0, 80));
vale('o cobrador ja avisou que saiu (mensagem dele depois da saida): a automatica nao repete, lido do servidor', !naPrevia(fila, '3024', 'saiu'), '');
vale('saiu pra entrega com comprovante no pedido: sai SEM a linha do valor', !!sai2 && !/Valor a pagar|R\$/.test(sai2.textos[0]) && /saiu para entrega hoje/.test(sai2.textos[0]), sai2 && sai2.textos[0]);
const ret1 = naPrevia(fila, '3022', 'retirada'), ret2 = naPrevia(fila, '3023', 'retirada');
vale('retirada com foto do cliente: sem "O valor de R$ ... depois de retirar"', !!ret1 && !/R\$/.test(ret1.textos[0]) && /agência dos Correios/.test(ret1.textos[0]), ret1 && ret1.textos[0].slice(0, 120));
vale('retirada sem sinal: com o valor', !!ret2 && /O valor de R\$ 497,00 você paga depois de retirar/.test(ret2.textos[0]), '');
const rec1 = naPrevia(fila, '3030', 'recepcao'), rec2 = naPrevia(fila, '3031', 'recepcao');
vale('boas-vindas de quem ja mandou comprovante: sem o "Localizei" com o valor', !!rec1 && rec1.textos.length === 2 && !rec1.textos.some((t) => /R\$/.test(t)), rec1 && rec1.textos.length);
vale('boas-vindas normal: com o "Localizei" e o valor', !!rec2 && rec2.textos.length === 3 && /Valor do pedido: R\$ 497,00/.test(rec2.textos[2]), rec2 && rec2.textos.length);

_log('\n3. NA HORA DE PEGAR, O SERVIDOR CONFERE DE NOVO\n');
// o app recebe 10 por vez: primeiro estes tres, depois os outros dois
let it = await itens();
const i3001 = de(it, '3001', 'naopagou'), i3004 = de(it, '3004', 'naopagou'), i3020 = de(it, '3020', 'saiu');
vale('o app recebe os lembretes de quem esta esquecido', !!(i3001 && i3004 && i3020) && !it.some((x) => /^npg:(3002|3003|3005|3006|3007|3009|3011)$/.test(x.k)), it.map((x) => x.k).join(','));
vale('o item continua levando o falouDesde pra pagina (a hora em que o pedido saiu)', i3020.falouDesde === Math.floor((T0 - 2 * H) / 1000), i3020.falouDesde);
lead('3001').col = 'Pagos'; lead('3001').spg = 'Pago'; gravaEstado();
let p = await pega(i3001);
vale('pagou entre a lista e o envio: a pega recusa com o motivo', p.ok === false && /já está pago/.test(p.erro), JSON.stringify(p));
vale('e fica registrado como pulado (nao volta)', (linha('npg:3001') || {}).status === 'pulado' && /pago/.test((linha('npg:3001') || {}).motivo), JSON.stringify(linha('npg:3001')));
msg('5531900003004', I_BRY, 'out', 'Bom dia Dora', 60);
p = await pega(i3004);
vale('o cobrador falou com ela depois da lista: recusa', p.ok === false && /cobrador já falou/.test(p.erro), JSON.stringify(p));
lead('3020').comments = [{ who: 'kev', tx: '', time: ddmm(0), kind: 'image', url: COMPROV }]; gravaEstado();
p = await pega(i3020);
vale('"saiu" de quem acabou de mandar comprovante: recusa sem registrar (volta sem o valor)', p.ok === false && /comprovante/.test(p.erro) && !linha('sai:3020'), JSON.stringify(p));
it = await itens();
const sai3 = de(it, '3020', 'saiu'), i3008 = de(it, '3008', 'naopagou'), i3010 = de(it, '3010', 'naopagou');
vale('a segunda lista traz os outros dois lembretes', !!(i3008 && i3010), it.map((x) => x.k).join(','));
lead('3008').comments.unshift({ who: 'bry', tx: 'Lead vai pagar segunda', time: ddmm(0) }); gravaEstado();
p = await pega(i3008);
vale('anotou no pedido depois da lista: recusa', p.ok === false && /anotação/.test(p.erro), JSON.stringify(p));
vale('...e a proxima lista traz o "saiu" sem a linha do valor', !!sai3 && !/R\$/.test(sai3.textos[0]), sai3 && sai3.textos[0].slice(0, 60));
p = await pega(i3010);
vale('quem continua esquecido: a pega deixa', p.ok === true, JSON.stringify(p));

_log('\n4. DE QUAL NUMERO E CADA CLIENTE (a aba Cobranca do painel)\n');
let q = await chama(TK.bry, '/api/swweb/cobranca');
const ped = (id) => (q.d.pedidos || []).find((x) => x.id === id) || {};
vale('o quadro manda os numeros do cobrador', Array.isArray(q.d.nums) && q.d.nums.length === 2 && q.d.nums[0].n8 === '27335679' && q.d.nums[1].num === '(11) 96663-2248', JSON.stringify(q.d.nums));
vale('quem fala no 5679 e do 5679, e ja falou la', ped('4001').numCli === '27335679' && JSON.stringify(ped('4001').falou) === '["27335679"]', JSON.stringify([ped('4001').numCli, ped('4001').falou]));
vale('quem fala no 2248 e do 2248', ped('4003').numCli === '66632248' && JSON.stringify(ped('4003').falou) === '["66632248"]', JSON.stringify([ped('4003').numCli, ped('4003').falou]));
vale('quem nunca chamou e nao tem marca: sem numero ainda', ped('4002').numCli === '' && ped('4002').falou.length === 0, JSON.stringify([ped('4002').numCli, ped('4002').falou]));
vale('quem o link ja mandou pro 2248 (marca do rodizio) e do 2248, sem ter falado', ped('4004').numCli === '66632248' && ped('4004').falou.length === 0, JSON.stringify([ped('4004').numCli, ped('4004').falou]));
let rg = await chama(TK.dir, '/api/cob/regra?fone=31900004001');
vale('o link do Beto abre o 5679 (onde ele conversa)', rg.d.simula && rg.d.simula.num === '5511927335679' && /conversa/.test(rg.d.simula.porque), JSON.stringify(rg.d.simula));
let sai4 = de(await itens(), '4001', 'saiu');
vale('a automatica do Beto sai pelo 5679', !!sai4 && sai4.nk === NK_BRY, sai4 && sai4.nk);

_log('\n5. PASSAR O CLIENTE PRA OUTRO NUMERO\n');
let mv = await chama(TK.hay, '/api/swweb/cobranca/numero', { phone: '31900004001', nk: NK_BRY2 });
vale('outro cobrador nao mexe no numero do Bryan', mv.st === 403, mv.st + ' ' + JSON.stringify(mv.d));
mv = await chama(TK.bry, '/api/swweb/cobranca/numero', { phone: '31900004001', nk: NK_HAY });
vale('o Bryan nao passa cliente pro numero do Haynan', mv.st === 403, mv.st);
mv = await chama(TK.kev, '/api/swweb/cobranca/numero', { phone: '31900004001', nk: NK_BRY2 });
vale('vendedor nao passa', mv.st === 403, mv.st);
mv = await chama(TK.dir, '/api/swweb/cobranca/numero', { phone: '31900004001', nk: '3155554444' });
vale('numero de vendedor nao recebe cliente da cobranca', mv.st === 400, mv.st + ' ' + JSON.stringify(mv.d));
mv = await chama(TK.bry, '/api/swweb/cobranca/numero', { phone: '1', nk: NK_BRY2 });
vale('telefone invalido: 400', mv.st === 400, mv.st);
mv = await chama(TK.bry, '/api/swweb/cobranca/numero', { phone: '5531900004001', nk: NK_BRY2 });
vale('o Bryan passa o Beto pro 2248', mv.st === 200 && mv.d.ok === true && mv.d.n8 === '66632248', JSON.stringify(mv.d));
const marca = sq.prepare("SELECT * FROM cob_num_cli WHERE k='3100004001'").get();
let ct = await chama(TK.bry, '/api/swweb/cobranca/contato?phone=5531900004001');
vale('o icone do quadro (onde abrir a conversa) passa a mandar o 2248 na frente', ct.d.numeros && ct.d.numeros[0].n8 === '66632248' && ct.d.numeros[0].manual === true && ct.d.numeros.some((x) => x.n8 === '27335679'), JSON.stringify(ct.d));
vale('a marca fica como escolha a mao', !!marca && marca.nk === NK_BRY2 && marca.origem === 'manual' && marca.at === 'bry', JSON.stringify(marca));
q = await chama(TK.bry, '/api/swweb/cobranca');
vale('o quadro passa a dizer 2248, e continua sabendo que ele falou no 5679 (o aviso)', ped('4001').numCli === '66632248' && JSON.stringify(ped('4001').falou) === '["27335679"]', JSON.stringify([ped('4001').numCli, ped('4001').falou]));
rg = await chama(TK.dir, '/api/cob/regra?fone=31900004001');
vale('o link passa a abrir o 2248, acima da conversa', rg.d.simula && rg.d.simula.num === '5511966632248' && /manual/.test(rg.d.simula.porque), JSON.stringify(rg.d.simula));
sai4 = de(await itens(), '4001', 'saiu');
vale('sem conversa no 2248 ainda, a automatica continua saindo pelo 5679 (nunca a primeira mensagem de numero desconhecido)', !!sai4 && sai4.nk === NK_BRY, sai4 && sai4.nk);
msg('5531900004001', I_BRY2, 'out', 'Oi Beto, agora te atendo por este numero', 3 * 3600);
sai4 = de(await itens(), '4001', 'saiu');
vale('o cobrador ja falou com ele no 2248: a automatica passa a sair pelo 2248', !!sai4 && sai4.nk === NK_BRY2, sai4 && sai4.nk);
mv = await chama(TK.dir, '/api/swweb/cobranca/numero', { phone: '31900004001', nk: NK_BRY });
vale('a direcao tambem passa (de volta pro 5679)', mv.st === 200 && sq.prepare("SELECT nk FROM cob_num_cli WHERE k='3100004001'").get().nk === NK_BRY, JSON.stringify(mv.d));
rg = await chama(TK.dir, '/api/cob/regra?fone=31900004001');
vale('e o link volta pro 5679', rg.d.simula && rg.d.simula.num === '5511927335679', JSON.stringify(rg.d.simula));
vale('cada passada fica no registro', logs.filter((x) => /^COB_NUM_MANUAL cli=4001/.test(x)).length === 2, logs.filter((x) => /COB_NUM_MANUAL/.test(x)).join(' | '));

_log('\n' + ok + ' certos, ' + falhas.length + ' errados' + (falhas.length ? ':\n  - ' + falhas.join('\n  - ') : ''));
process.exit(falhas.length ? 1 : 0);
