// CADA UM ARRUMA O TEXTO DELE NAS AUTOMACOES DA COBRANCA (13/11/2026). Roda o worker inteiro (bundle
// do wrangler) contra um D1 de mentira e prova, pelas rotas de verdade:
//
//  O COBRADOR SALVA O TEXTO DELE (POST /api/swweb/auto/config {campo, texto}) e ele so vale no que sai
//    pelos numeros dele; o outro cobrador continua com o da casa. Texto igual ao da casa nao e gravado;
//    {campo, padrao: true} devolve.
//  A DIRECAO, no "ver como", salva so pra aquele cobrador (`de`) ou PRA TODOS (`todos`: troca o texto da
//    casa e apaga a versao propria de todo mundo naquele campo, sem mexer no ligado/desligado).
//  A CONFERENCIA: palavra entre chaves que a mensagem nao sabe preencher, chave solta, texto vazio e
//    texto grande demais sao recusados com a frase que a tela mostra.
//  {saudacao} e {primeiro} valem em TODOS os textos (os quatro antigos passaram pro _cobAutoMonta), e
//    os textos padrao saem iguais a antes.
//  A DASH ve quem tem texto proprio (`proprios`), a previa da fila usa ele, e {limpa} devolve ao da casa.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-cob-auto3.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-cob-auto3.mjs <bundle>/worker.js'); process.exit(2); }
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
// O RELOGIO E DO TESTE: 10/11/2026 10:00 de Brasilia (13:00 UTC).
const T0 = Date.UTC(2026, 10, 10, 13, 0, 0);
Date.now = () => T0;
const _log = console.log;
const logs = [];
console.log = (...a) => { logs.push(a.join(' ')); };

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + String(detalhe).slice(0, 200) : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + String(detalhe).slice(0, 500) : '')); }
};

const S = () => Math.floor(T0 / 1000);
const usuarios = [
  ['dir', 'Diretor', 'diretor', null], ['bry', 'Bryan Amorim', 'cobrador', null], ['hay', 'Haynan', 'cobrador', null],
  ['kev', 'Kevin Marques', 'atendente', null],
];
for (const [id, nome, role, afl] of usuarios) {
  sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role);
  sq.prepare('UPDATE users SET afiliado_id=?, archived=0 WHERE id=?').run(afl, id);
}
const TK = { dir: 'd'.repeat(64), bry: 'b'.repeat(64), hay: 'c'.repeat(64), kev: 'e'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, S() + 30 * 86400);

const NK_BRY = '1127335679', NK_HAY = '1591980514';
const I_BRY = 'ax_bry_27335679', I_HAY = 'ax_hay_91980514';
const H = 3600000;
const iso = (msAtras) => new Date(T0 - msAtras).toISOString();
const hist = (de, para, msAtras) => ({ from: de, to: para, who: 'five', time: iso(msAtras) });
const base = { vl: 497, mod: 'entrega', at: 'kev', cob: 'bry', end: 'Rua das Flores', num: '120', bairro: 'Centro', cidade: 'Betim', uf: 'mg', cep: '32600-000' };
const estado = {
  wa_statuses: [{ id: 'st_uso', label: 'Em uso', papel: 'em_uso' }],
  chips: [
    { id: 'c1', num: '(11) 92733-5679', at: 'bry', em_uso: true, st: 'ativo' },
    { id: 'c2', num: '(15) 99198-0514', at: 'hay', em_uso: true, st: 'ativo' },
  ],
  pressels: [],
  leads: [
    // saiu pra entrega hoje: uma do Bryan, uma do Haynan
    { ...base, id: '2001', nome: 'MARIA SAIU HOJE', wa: '(31) 90000-2001', col: 'Rota de Entrega', track: '888030000002001', ship: 'IN_TRANSIT_TO_DELIVERY', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    { ...base, id: '2014', nome: 'Mara do Haynan', wa: '(31) 90000-2014', cob: 'hay', col: 'Rota de Entrega', track: '888030000002014', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    // pagou ha 2 h (Bryan)
    { ...base, id: '2012', nome: 'Katia Pagou', wa: '(31) 90000-2012', col: 'Pagos', spg: 'Pago', pago_ts: T0 - 2 * H, hist: [hist('Cobrança', 'Pagos', 2 * H)] },
    // boas-vindas: ja despachado (Bryan), ainda nao despachado (Bryan) e ainda nao despachado (Haynan)
    { ...base, id: '2021', nome: 'Sara Ja Saiu', wa: '(31) 90000-2021', col: 'Enviado', track: '888030000002021', ship_ts: Math.floor(T0 / 1000) - 3600, hist: [hist('Preparando', 'Enviado', 1 * H)] },
    { ...base, id: '2022', nome: 'Tais Nao Saiu', wa: '(31) 90000-2022', col: 'A Enviar' },
    { ...base, id: '2030', nome: 'Vera do Haynan', wa: '(31) 90000-2030', cob: 'hay', col: 'A Enviar' },
  ],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));
let mid = 0;
const msg = (phone, inst, dir, body, segAtras) => sq.prepare('INSERT INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts, mundo) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('m' + (++mid), phone, inst, dir, 'text', body, '', S() - segAtras, '');
for (const n of ['2001', '2012']) { msg('553190000' + n, I_BRY, 'in', 'oi', 5 * 86400); msg('553190000' + n, I_BRY, 'out', 'Boa tarde', 5 * 86400 - 60); }
msg('5531900002014', I_HAY, 'in', 'oi', 5 * 86400);
msg('5531900002014', I_HAY, 'out', 'Boa tarde', 5 * 86400 - 60);
msg('5531900002021', I_BRY, 'in', 'Olá! Quero acompanhar o meu pedido.', 200);
msg('5531900002022', I_BRY, 'in', 'Olá! Quero acompanhar o meu pedido.', 200);
msg('5531900002030', I_HAY, 'in', 'Olá! Quero acompanhar o meu pedido.', 200);

const aluga = (nk, quem, maq) => sq.prepare('INSERT OR REPLACE INTO swweb_uso (nk,user_id,nome,maquina,desde,ate,versao) VALUES (?,?,?,?,?,?,?)').run(nk, quem, quem, maq, S() - 600, S() + 120, '1.26.19');
const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-cob-auto3.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const chama = async (tk, path, body, maquina) => {
  aluga(NK_BRY, 'bry', 'mb'); aluga(NK_HAY, 'hay', 'mh');
  const h = { authorization: 'Bearer ' + tk };
  if (body) h['content-type'] = 'application/json';
  if (maquina) { h['x-sw-maquina'] = maquina; h['x-sw-versao'] = '1.26.19'; }
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
const itens = async (quem = 'bry') => (await chama(TK[quem], '/api/swweb/auto?nks=' + (quem === 'hay' ? NK_HAY : NK_BRY), null, quem === 'hay' ? 'mh' : 'mb')).d.itens || [];
const dePed = (lista, ped, tipo) => (lista || []).find((x) => String(x.pedido) === String(ped) && (!tipo || x.tipo === tipo));
const cfgDe = async (quem, como) => (await chama(TK[quem], '/api/swweb/auto/config?v=1' + (como ? '&como=' + como : ''), null, 'm' + quem[0])).d;
const txDe = (d, campo) => { for (const t of (d.tipos || [])) for (const x of (t.textos || [])) if (x.campo === campo) return x; return null; };
const salva = (quem, corpo) => chama(TK[quem], '/api/swweb/auto/config', corpo, 'm' + quem[0]);
const cru = (k) => { const r = sq.prepare('SELECT value FROM app_config WHERE key=?').get(k); return r ? JSON.parse(r.value) : null; };
const TODAS = { rec: true, recr: true, pos: true, sai: true, ent: true, ret: true, nach: true, npg: true, atr: true, pag: true };
const APRES = 'Aqui quem fala é o Elias sou o rapaz responsável pela parte da entrega e financeira do tratamento da GlicoSix.';

let r = await chama(TK.dir, '/api/cob/auto', TODAS);
vale('a direcao liga as dez', r.st === 200 && Object.keys(TODAS).every((k) => r.d.cfg[k] === true));

_log('\nOS TEXTOS PADRAO SAEM IGUAIS A ANTES\n');
let it = await itens();
const tais0 = dePed(it, '2022', 'recepcao'), sara0 = dePed(it, '2021', 'recepcao'), maria0 = dePed(it, '2001', 'saiu');
vale('boas-vindas (pedido que nao saiu): saudacao com o nome inteiro, apresentacao e o "Localizei" com o valor',
  !!tais0 && tais0.textos.length === 3 && tais0.textos[0] === 'Bom dia Tais Nao Saiu' && tais0.textos[1] === APRES
  && /^Localizei o seu pedido do Glico Six por aqui\./.test(tais0.textos[2]) && /💰 Valor do pedido: R\$ 497,00\n📦 Pagamento somente na entrega/.test(tais0.textos[2]) && /eu aviso por aqui\. 👍$/.test(tais0.textos[2]),
  tais0 && JSON.stringify(tais0.textos.map((x) => x.slice(0, 40))));
vale('boas-vindas com rastreio: o codigo e o link vao no ultimo texto',
  !!sara0 && /^Tenho uma atualização do seu Glico Six\. 📦/.test(sara0.textos[sara0.textos.length - 1]) && /📦 Código de rastreio: 888030000002021\n🔗 Acompanhar entrega: http/.test(sara0.textos[sara0.textos.length - 1]) && sara0.codigo === '888030000002021',
  sara0 && sara0.textos[sara0.textos.length - 1].slice(0, 200));
vale('saiu pra entrega: o texto padrao com o primeiro nome e o valor', !!maria0 && /^Boa notícia, Maria! Seu pedido do Glico Six saiu para entrega hoje\. 🚚/.test(maria0.textos[0]) && /R\$ 497,00/.test(maria0.textos[0]), maria0 && maria0.textos[0].slice(0, 90));

_log('\nA ABA DO COBRADOR DIZ O QUE DA PRA EDITAR\n');
let c = await cfgDe('bry');
let x = txDe(c, 'saiu');
vale('cada texto vem com o campo, se e proprio e o que cabe nele', c.edita === true && !!x && x.proprio === false && x.vars.join(',') === 'saudacao,primeiro,valor' && /^Boa notícia, \{primeiro\}!/.test(x.texto), JSON.stringify(x && { p: x.proprio, v: x.vars }));
vale('o cobrador nao e direcao e nao esta vendo ninguem', c.dir === false && c.de === null && c.varRot && c.varRot.primeiro === 'Primeiro nome', JSON.stringify([c.dir, c.de]));
vale('todo texto do catalogo tem campo e variaveis conhecidas', c.tipos.every((t) => t.textos.every((y) => y.campo && Array.isArray(y.vars) && y.vars.every((v) => c.varRot[v]))), '');

_log('\nO COBRADOR SALVA O TEXTO DELE\n');
const MEU_SAIU = '{saudacao}, {primeiro}! Aqui é o Bryan. Seu Glico Six saiu pra entrega hoje.\n\nValor: R$ {valor}';
r = await salva('bry', { campo: 'saiu', texto: MEU_SAIU });
x = txDe(r.d, 'saiu');
vale('salvar devolve a aba ja com o texto dele marcado como proprio', r.st === 200 && r.d.ok && !!x && x.proprio === true && x.texto === MEU_SAIU, JSON.stringify({ st: r.st, e: r.d.error }));
vale('fica gravado so no nome dele, com a hora', JSON.stringify(Object.keys(cru('cob_auto_pessoa'))) === '["bry"]' && cru('cob_auto_pessoa').bry.txt.saiu === MEU_SAIU && cru('cob_auto_pessoa').bry.txt_em.saiu === T0, JSON.stringify(cru('cob_auto_pessoa')).slice(0, 120));
vale('o texto da casa nao mudou', !cru('cob_auto').txt || !cru('cob_auto').txt.saiu, JSON.stringify(cru('cob_auto').txt));
x = txDe(await cfgDe('hay'), 'saiu');
vale('o outro cobrador continua com o texto da casa', !!x && x.proprio === false && /^Boa notícia, \{primeiro\}!/.test(x.texto), x && x.texto.slice(0, 40));
it = await itens();
const maria1 = dePed(it, '2001', 'saiu');
vale('pelo numero do Bryan sai o texto DELE, preenchido', !!maria1 && maria1.textos[0] === 'Bom dia, Maria! Aqui é o Bryan. Seu Glico Six saiu pra entrega hoje.\n\nValor: R$ 497,00', maria1 && maria1.textos[0]);
vale('e a parte de texto que o app manda e a mesma', !!maria1 && maria1.partes[0].texto === maria1.textos[0], '');
const mara1 = dePed(await itens('hay'), '2014', 'saiu');
vale('pelo numero do Haynan continua saindo o da casa', !!mara1 && /^Boa notícia, Mara! Seu pedido do Glico Six saiu para entrega hoje/.test(mara1.textos[0]), mara1 && mara1.textos[0].slice(0, 60));

_log('\nA CONFERENCIA DO TEXTO\n');
r = await salva('bry', { campo: 'saiu', texto: 'Oi {Nome}, saiu!' });
vale('palavra entre chaves que a mensagem nao conhece e recusada, com o que pode usar', r.st === 400 && /não sabe preencher \{Nome\}/.test(r.d.error) && /\{primeiro\}/.test(r.d.error), r.d.error);
r = await salva('bry', { campo: 'saudacao', texto: '{saudacao} {primeiro}, seu código é {codigo}' });
vale('variavel de outra mensagem (o codigo na saudacao) tambem', r.st === 400 && /\{codigo\}/.test(r.d.error), r.d.error);
r = await salva('bry', { campo: 'pagou', texto: 'Recebi, {primeiro! Obrigado' });
vale('chave solta e recusada', r.st === 400 && /chave/.test(r.d.error), r.d.error);
r = await salva('bry', { campo: 'pagou', texto: '   ' });
vale('texto vazio e recusado (pra nao sair, desliga)', r.st === 400 && /desligue/.test(r.d.error), r.d.error);
r = await salva('bry', { campo: 'pagou', texto: 'a'.repeat(2001) });
vale('texto grande demais e recusado', r.st === 400 && /2\.000/.test(r.d.error), r.d.error);
r = await salva('bry', { campo: 'inventado', texto: 'oi' });
vale('mensagem que nao existe e recusada', r.st === 400, r.d.error);
vale('nada disso mexeu no que estava salvo', JSON.stringify(cru('cob_auto_pessoa').bry.txt) === JSON.stringify({ saiu: MEU_SAIU }), JSON.stringify(cru('cob_auto_pessoa').bry.txt).slice(0, 80));
r = await salva('bry', { campo: 'naopagou', texto: 'Oi {primeiro}, segue o link: {link_pag}' });
vale('a variavel propria da mensagem (link de pagamento no "nao pagou") e aceita', r.st === 200 && txDe(r.d, 'naopagou').proprio === true, r.d.error);

_log('\nQUEM PODE O QUE\n');
r = await salva('hay', { campo: 'saiu', texto: 'Oi {primeiro}', de: 'bry' });
vale('um cobrador nao mexe no texto do outro', r.st === 403, String(r.st));
r = await salva('hay', { campo: 'saiu', texto: 'Oi {primeiro}', todos: true });
vale('nem troca o texto de todos', r.st === 403 && !(cru('cob_auto').txt || {}).saiu, String(r.st));
r = await salva('kev', { campo: 'saiu', texto: 'Oi {primeiro}' });
vale('vendedor nao tem automacao', r.st === 403, String(r.st));

_log('\nLIGAR E DESLIGAR CONVIVE COM O TEXTO\n');
r = await salva('bry', { id: 'ret', ligado: false });
vale('desligar uma automacao guarda o desligado e nao perde os textos', r.st === 200 && cru('cob_auto_pessoa').bry.ret === false && cru('cob_auto_pessoa').bry.txt.saiu === MEU_SAIU, JSON.stringify(Object.keys(cru('cob_auto_pessoa').bry)));
r = await salva('bry', { id: 'ret', ligado: true });
vale('ligar de novo tira so o desligado', r.st === 200 && !('ret' in cru('cob_auto_pessoa').bry) && cru('cob_auto_pessoa').bry.txt.saiu === MEU_SAIU, JSON.stringify(Object.keys(cru('cob_auto_pessoa').bry)));

_log('\n{saudacao} E {primeiro} VALEM NOS TEXTOS ANTIGOS TAMBEM\n');
r = await salva('bry', { campo: 'saudacao', texto: '{saudacao}, {primeiro}!' });
vale('a saudacao aceita o primeiro nome', r.st === 200, r.d.error);
r = await salva('bry', { campo: 'apresenta', texto: 'Aqui é o Bryan, {primeiro}. Cuido da sua entrega.' });
r = await salva('bry', { campo: 'postado', texto: '{saudacao}, {primeiro}! Seu código: {codigo}\nAcompanhe: {link}' });
vale('o codigo de rastreio aceita saudacao e primeiro nome', r.st === 200, r.d.error);
it = await itens();
const tais2 = dePed(it, '2022', 'recepcao'), sara2 = dePed(it, '2021', 'recepcao');
vale('boas-vindas do Bryan: a saudacao e a apresentacao dele, e o "Localizei" da casa',
  !!tais2 && tais2.textos[0] === 'Bom dia, Tais!' && tais2.textos[1] === 'Aqui é o Bryan, Tais. Cuido da sua entrega.' && /^Localizei o seu pedido/.test(tais2.textos[2]), tais2 && JSON.stringify(tais2.textos.slice(0, 2)));
vale('boas-vindas com rastreio do Bryan: o codigo vai no texto dele', !!sara2 && /^Bom dia, Sara! Seu código: 888030000002021\nAcompanhe: http/.test(sara2.textos[sara2.textos.length - 1]) && sara2.codigo === '888030000002021', sara2 && sara2.textos[sara2.textos.length - 1].slice(0, 80));
const vera = dePed(await itens('hay'), '2030', 'recepcao');
vale('boas-vindas do Haynan: tudo da casa', !!vera && vera.textos[0] === 'Bom dia Vera do Haynan' && vera.textos[1] === APRES, vera && JSON.stringify(vera.textos.slice(0, 2)));

_log('\nVOLTAR AO PADRAO\n');
r = await salva('bry', { campo: 'apresenta', padrao: true });
vale('voltar ao padrao apaga a versao dele daquele texto', r.st === 200 && txDe(r.d, 'apresenta').proprio === false && txDe(r.d, 'apresenta').texto === APRES && !('apresenta' in cru('cob_auto_pessoa').bry.txt), JSON.stringify(Object.keys(cru('cob_auto_pessoa').bry.txt)));
r = await salva('bry', { campo: 'saudacao', texto: '{saudacao} {nome}' });
vale('salvar igual ao da casa nao guarda copia', r.st === 200 && txDe(r.d, 'saudacao').proprio === false && !('saudacao' in cru('cob_auto_pessoa').bry.txt), JSON.stringify(Object.keys(cru('cob_auto_pessoa').bry.txt)));

_log('\nA DIRECAO NO "VER COMO"\n');
c = await cfgDe('dir', 'bry');
vale('a direcao vendo o Bryan: a aba e a dele, e sabe que quem olha e a direcao', c.dir === true && c.de && c.de.id === 'bry' && c.de.nome === 'Bryan' && txDe(c, 'saiu').proprio === true && txDe(c, 'saiu').texto === MEU_SAIU, JSON.stringify([c.dir, c.de]));
r = await salva('dir', { campo: 'pagou', texto: 'Pagamento recebido, {primeiro}. Obrigado!', de: 'hay' });
vale('"so pro Haynan": grava a versao dele', r.st === 200 && cru('cob_auto_pessoa').hay.txt.pagou === 'Pagamento recebido, {primeiro}. Obrigado!' && !(cru('cob_auto').txt || {}).pagou && r.d.de && r.d.de.id === 'hay' && txDe(r.d, 'pagou').proprio === true, JSON.stringify(r.d.de));
r = await salva('bry', { campo: 'pagou', texto: 'Valeu, {primeiro}! Recebi aqui.' });
const antes = cru('cob_auto');
r = await salva('dir', { campo: 'pagou', texto: 'Recebemos o seu pagamento, {primeiro}! ✅', de: 'bry', todos: true });
const dep = cru('cob_auto'), pp = cru('cob_auto_pessoa');
vale('"pra todos": o texto da casa muda', r.st === 200 && dep.txt.pagou === 'Recebemos o seu pagamento, {primeiro}! ✅' && dep.por === 'Diretor' && dep.em === T0, JSON.stringify(dep.txt));
vale('e a versao propria de TODO MUNDO naquele texto sai', !(pp.bry.txt && pp.bry.txt.pagou) && !(pp.hay && pp.hay.txt && pp.hay.txt.pagou), JSON.stringify(pp).slice(0, 200));
vale('os outros textos proprios ficam (o "saiu" e o "nao pagou" do Bryan)', pp.bry.txt.saiu === MEU_SAIU && !!pp.bry.txt.naopagou && !!pp.bry.txt.postado, JSON.stringify(Object.keys(pp.bry.txt)));
vale('o ligado e desligado da casa nao foi tocado', Object.keys(TODAS).every((k) => dep[k] === antes[k]) && ('recr' in dep) === ('recr' in antes), JSON.stringify(Object.keys(dep)));
vale('a aba que volta e a do Bryan, ja com o texto novo da casa', txDe(r.d, 'pagou').proprio === false && txDe(r.d, 'pagou').texto === 'Recebemos o seu pagamento, {primeiro}! ✅', txDe(r.d, 'pagou').texto);
it = await itens();
const katia = dePed(it, '2012', 'pagou');
vale('e o que sai pro cliente e o texto novo', !!katia && katia.textos[0] === 'Recebemos o seu pagamento, Katia! ✅', katia && katia.textos[0]);
r = await salva('dir', { campo: 'pagou', texto: 'Recebi a confirmação do seu pagamento, {primeiro}! ✅\n\nMuito obrigado pela confiança. Qualquer dúvida sobre o tratamento, é só me chamar aqui. 👍', todos: true });
vale('"pra todos" com o texto de fabrica nao guarda copia na casa', r.st === 200 && !('pagou' in (cru('cob_auto').txt || {})), JSON.stringify(cru('cob_auto').txt));
r = await salva('dir', { campo: 'atrasou', texto: 'Oi {primeiro}, seu pedido atrasou um pouco. {link}' });
vale('a direcao sem "ver como" salva o texto da casa (ela nao tem numero de cobranca)', r.st === 200 && cru('cob_auto').txt.atrasou === 'Oi {primeiro}, seu pedido atrasou um pouco. {link}' && !cru('cob_auto_pessoa').dir, JSON.stringify(cru('cob_auto').txt));

_log('\nA DASH VE QUEM TEM TEXTO PROPRIO\n');
r = await chama(TK.dir, '/api/cob/auto');
const pr = r.d.proprios || [];
vale('a lista traz quem, qual mensagem, o texto e quando', pr.length === 3 && pr.every((p) => p.uid === 'bry' && p.nome === 'Bryan Amorim' && p.texto && p.em === T0) && pr.map((p) => p.campo).join(',') === 'postado,saiu,naopagou', JSON.stringify(pr.map((p) => p.campo)));
const filaMaria = (r.d.fila || []).find((f) => f.nome === 'Maria Saiu Hoje' && f.tipo === 'saiu');
vale('a previa da fila mostra o texto que vai sair de verdade (o do Bryan)', !!filaMaria && /^Bom dia, Maria! Aqui é o Bryan\./.test(filaMaria.textos[0]), filaMaria && filaMaria.textos[0].slice(0, 60));
r = await chama(TK.dir, '/api/cob/auto', { limpa: { uid: 'bry', campo: 'saiu' } });
vale('a direcao devolve um texto ao da casa pela dash', r.st === 200 && (r.d.proprios || []).map((p) => p.campo).join(',') === 'postado,naopagou' && !('saiu' in cru('cob_auto_pessoa').bry.txt), JSON.stringify((r.d.proprios || []).map((p) => p.campo)));
vale('e isso nao mexe em mais nada da casa', Object.keys(TODAS).every((k) => r.d.cfg[k] === true) && r.d.cfg.txt.atrasou === 'Oi {primeiro}, seu pedido atrasou um pouco. {link}', '');
r = await chama(TK.bry, '/api/cob/auto', { limpa: { uid: 'bry', campo: 'postado' } });
vale('so a direcao usa a tela da dash', r.st === 403 && !!cru('cob_auto_pessoa').bry.txt.postado, String(r.st));
r = await chama(TK.dir, '/api/cob/auto', { txt: { saiu: 'Novo texto da casa, {primeiro}.' } });
vale('salvar os textos pela dash continua como era e nao apaga o proprio de ninguem', r.st === 200 && r.d.cfg.txt.saiu === 'Novo texto da casa, {primeiro}.' && !!cru('cob_auto_pessoa').bry.txt.postado && r.d.cfg.txt.atrasou === 'Oi {primeiro}, seu pedido atrasou um pouco. {link}', JSON.stringify(Object.keys(cru('cob_auto').txt)));
const maria3 = dePed(await itens(), '2001', 'saiu');
vale('sem texto proprio, o Bryan volta a mandar o da casa', !!maria3 && maria3.textos[0] === 'Novo texto da casa, Maria.', maria3 && maria3.textos[0]);

// ══ A VISAO DA CASA (13/11/2026, rodada 2) ══ o Bruno: "para mim, como diretor, esta quase impossivel"
// chegar na aba pelo "ver como". A direcao SEM "ver como" ve a operacao inteira e mexe no que e da casa.
_log('\nA DIRECAO SEM "VER COMO" VE A CASA\n');
const poe = sq.prepare("INSERT INTO swweb_auto (k, tipo, nk, fone, pedido, nome, status, n, pego_ts, feito_ts) VALUES (?, ?, ?, '5531900000000', '1', ?, 'enviado', 1, ?, ?)");
poe.run('sai:casa1', 'saiu', NK_BRY, 'Cliente do Bryan', S() - 300, S() - 300);
poe.run('sai:casa2', 'saiu', NK_HAY, 'Cliente do Haynan', S() - 200, S() - 200);
poe.run('pag:casa3', 'pagou', NK_HAY, 'Outro do Haynan', S() - 100, S() - 100);
await salva('bry', { id: 'ret', ligado: false });
c = await cfgDe('dir');
const tp = (d, id) => (d.tipos || []).find((t) => t.id === id) || {};
const casaTxt = (await chama(TK.dir, '/api/cob/auto')).d.cfg.txt;
vale('a aba da direcao e a da casa: sem "de", com a lista dos cobradores pro seletor', c.casa === true && c.dir === true && c.de === null && JSON.stringify(c.cobradores) === JSON.stringify([{ id: 'bry', nome: 'Bryan' }, { id: 'hay', nome: 'Haynan' }]), JSON.stringify([c.casa, c.de, c.cobradores]));
vale('o interruptor e o da operacao (as dez ligadas) e nunca "desligada pela direcao"', c.tipos.length === 10 && c.tipos.every((t) => t.meu === true && t.direcao === true), c.tipos.filter((t) => !t.meu).map((t) => t.id).join(','));
vale('conta o que saiu hoje por TODOS os numeros de cobrador', tp(c, 'sai').hoje === 2 && tp(c, 'pag').hoje === 1 && c.numeros === 2, JSON.stringify([tp(c, 'sai').hoje, tp(c, 'pag').hoje, c.numeros]));
vale('os ultimos envios sao de todos, com o nome de quem mandou', c.ultimos.length === 3 && c.ultimos.map((x) => x.quem + ':' + x.id).join('|') === 'Haynan:pag|Haynan:sai|Bryan:sai', JSON.stringify(c.ultimos.map((x) => [x.quem, x.id])));
vale('diz quem desligou a dele e quem usa outro texto', tp(c, 'ret').desligou.join(',') === 'Bryan' && tp(c, 'sai').desligou.length === 0
  && txDe(c, 'postado').outros.join(',') === 'Bryan' && txDe(c, 'pagou').outros.length === 0, JSON.stringify([tp(c, 'ret').desligou, txDe(c, 'postado').outros]));
vale('e o texto que aparece e o DA CASA, mesmo onde um cobrador mudou o dele', txDe(c, 'postado').proprio === false && txDe(c, 'postado').texto === casaTxt.postado && txDe(c, 'saiu').texto === 'Novo texto da casa, {primeiro}.', txDe(c, 'postado').texto.slice(0, 40));
await salva('bry', { id: 'ret', ligado: true });
r = await salva('dir', { id: 'atr', ligado: false });
vale('a direcao desliga uma automacao PRA OPERACAO (o mesmo cob_auto da dash), sem criar nada no nome dela', r.st === 200 && r.d.casa === true && tp(r.d, 'atr').meu === false && cru('cob_auto').atr === false && cru('cob_auto').por === 'Diretor' && !cru('cob_auto_pessoa').dir, JSON.stringify([tp(r.d, 'atr').meu, cru('cob_auto').atr]));
vale('so aquela chave mudou (as outras nove e os textos da casa continuam)', Object.keys(TODAS).filter((k) => k !== 'atr').every((k) => cru('cob_auto')[k] === true) && cru('cob_auto').txt.saiu === 'Novo texto da casa, {primeiro}.', JSON.stringify(Object.keys(TODAS).filter((k) => cru('cob_auto')[k] !== true)));
vale('a dash enxerga a mesma coisa', (await chama(TK.dir, '/api/cob/auto')).d.cfg.atr === false);
c = await cfgDe('bry');
vale('e o cobrador ve "desligada pela direcao"', tp(c, 'atr').direcao === false && tp(c, 'atr').meu === true, JSON.stringify([tp(c, 'atr').direcao, tp(c, 'atr').meu]));
r = await salva('dir', { id: 'atr', ligado: true });
vale('ligar de novo volta pra operacao', r.st === 200 && tp(r.d, 'atr').meu === true && cru('cob_auto').atr === true);
c = await cfgDe('bry');
vale('o cobrador continua com a aba dele: sem casa e sem a lista de cobradores', c.casa === false && c.cobradores === undefined && c.dir === false && tp(c, 'sai').hoje === 1 && c.ultimos.length === 1 && c.ultimos[0].quem === undefined, JSON.stringify([c.casa, c.cobradores, tp(c, 'sai').hoje, c.ultimos.length]));
c = await cfgDe('dir', 'hay');
vale('a direcao escolhendo um cobrador ve a dele, e continua com a lista pro seletor', c.casa === false && c.dir === true && c.de.id === 'hay' && c.cobradores.length === 2 && tp(c, 'sai').hoje === 1 && tp(c, 'pag').hoje === 1 && c.ultimos.length === 2, JSON.stringify([c.casa, c.de, tp(c, 'sai').hoje]));
r = await salva('dir', { id: 'sai', ligado: false, de: 'hay' });
vale('com `de`, o interruptor e o DO COBRADOR (a casa nao muda) e a aba que volta e a dele', r.st === 200 && r.d.casa === false && r.d.de.id === 'hay' && tp(r.d, 'sai').meu === false && cru('cob_auto').sai === true && cru('cob_auto_pessoa').hay.sai === false, JSON.stringify([r.d.casa, tp(r.d, 'sai').meu, cru('cob_auto').sai]));
await salva('dir', { id: 'sai', ligado: true, de: 'hay' });
r = await salva('bry', { id: 'sai', ligado: false });
vale('o cobrador desligando continua mexendo so na dele', r.st === 200 && cru('cob_auto').sai === true && cru('cob_auto_pessoa').bry.sai === false);
await salva('bry', { id: 'sai', ligado: true });

_log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) { _log('FALHARAM:\n - ' + falhas.join('\n - ')); process.exit(1); }
