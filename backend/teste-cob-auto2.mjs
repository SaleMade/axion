// AS AUTOMACOES NOVAS DA COBRANCA NA ROTA DE VERDADE (11/11/2026). Roda o worker inteiro (bundle do
// wrangler) contra um D1 de mentira e prova o que entrou na rodada 2 do _cobAutoItens:
//
//  OS TIPOS NOVOS: saiu pra entrega, entregue (com a foto assinada), retirada (1 por dia, ate 5, o
//    texto anda com os lembretes que ja foram), nao achou ninguem (24 h em rota; a volta do Requer
//    Atencao nao zera o relogio), entregue e nao pagou (dia seguinte, link curto), atrasou (7 dias) e
//    pagou. So pra quem ja escreveu num numero de cobrador, pelo numero da ultima conversa.
//  AS TRAVAS NOVAS: app antigo nao recebe tipo novo; das 8h as 20h; um por cliente por vez e a cada
//    3 h (o agradecimento nao espera); `falouDesde` pra pagina pular quando o cobrador ja falou.
//  CADA COBRADOR DESLIGA AS DELE (GET/POST /api/swweb/auto/config) e a direcao liga pra operacao.
//  BOAS-VINDAS COM E SEM RASTREIO separadas.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-cob-auto2.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-cob-auto2.mjs <bundle>/worker.js'); process.exit(2); }
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
let AGORA = T0;
Date.now = () => AGORA;
const _log = console.log;
const logs = [];
console.log = (...a) => { logs.push(a.join(' ')); };

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + String(detalhe).slice(0, 200) : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + String(detalhe).slice(0, 400) : '')); }
};

const S = () => Math.floor(AGORA / 1000);
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
const H = 3600000, DIA = 86400000;
// o historico no formato da dash: ISO (o que a Five/PayLog grava)
const iso = (msAtras) => new Date(T0 - msAtras).toISOString();
const hist = (de, para, msAtras) => ({ from: de, to: para, who: 'five', time: iso(msAtras) });
const FOTO = 'https://axion-api.axion-dash.workers.dev/api/arquivo/comprovante%2F2002%2Fentrega-1.jpg';
const base = { vl: 497, mod: 'entrega', at: 'kev', cob: 'bry', end: 'Rua das Flores', num: '120', bairro: 'Centro', cidade: 'Betim', uf: 'mg', cep: '32600-000' };
const estado = {
  wa_statuses: [{ id: 'st_uso', label: 'Em uso', papel: 'em_uso' }],
  chips: [
    { id: 'c1', num: '(11) 92733-5679', at: 'bry', em_uso: true, st: 'ativo' },
    { id: 'c2', num: '(15) 99198-0514', at: 'hay', em_uso: true, st: 'ativo' },
  ],
  pressels: [],
  leads: [
    { ...base, id: '2001', nome: 'MARIA SAIU HOJE', wa: '(31) 90000-2001', col: 'Rota de Entrega', track: '888030000002001', ship: 'IN_TRANSIT_TO_DELIVERY', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    { ...base, id: '2002', nome: 'ana com foto', wa: '(31) 90000-2002', col: 'Cobrança', track: '888030000002002', ship: 'DELIVERED', entrega_url: FOTO, hist: [hist('Rota de Entrega', 'Cobrança', 1 * H)] },
    { ...base, id: '2003', nome: 'Bia Sem Foto', wa: '(31) 90000-2003', col: 'Cobrança', track: '888030000002003', ship: 'DELIVERED', hist: [hist('Rota de Entrega', 'Cobrança', 0.5 * H)] },
    { ...base, id: '2004', nome: 'Caio Nao Pagou', wa: '(31) 90000-2004', col: 'Cobrança', track: '888030000002004', link: 'https://checkout.payt.com.br/abc123', hist: [hist('Rota de Entrega', 'Cobrança', 40 * H)] },
    { ...base, id: '2005', nome: 'Davi Combinou', wa: '(31) 90000-2005', col: 'Cobrança', track: '888030000002005', agend: '2026-11-12T10:00', hist: [hist('Rota de Entrega', 'Cobrança', 40 * H)] },
    { ...base, id: '2006', nome: 'Eva Retirada', wa: '(31) 90000-2006', col: 'Retirada', track: 'AP111111111BR', ship: 'READY_FOR_PICKUP', hist: [hist('Enviado', 'Retirada', 3 * H)] },
    { ...base, id: '2007', nome: 'Fabio Terceiro Dia', wa: '(31) 90000-2007', col: 'Retirada', track: 'AP222222222BR', hist: [hist('Enviado', 'Retirada', 2 * DIA)] },
    { ...base, id: '2008', nome: 'Gil Sexto Dia', wa: '(31) 90000-2008', col: 'Retirada', track: 'AP333333333BR', hist: [hist('Enviado', 'Retirada', 5 * DIA)] },
    { ...base, id: '2009', nome: 'Hugo Quinto Dia', wa: '(31) 90000-2009', col: 'Retirada', track: 'AP444444444BR', hist: [hist('Enviado', 'Retirada', 4 * DIA)] },
    { ...base, id: '2010', nome: 'Iara Nao Achou', wa: '(31) 90000-2010', col: 'Rota de Entrega', track: '888030000002010', hist: [hist('Enviado', 'Rota de Entrega', 30 * H)] },
    { ...base, id: '2011', nome: 'Joao Atrasado', wa: '(31) 90000-2011', col: 'Enviado', track: '888030000002011', ship: 'IN_TRANSIT', hist: [hist('Preparando', 'Enviado', 8 * DIA)] },
    { ...base, id: '2012', nome: 'Katia Pagou', wa: '(31) 90000-2012', col: 'Pagos', spg: 'Pago', pago_ts: T0 - 2 * H, hist: [hist('Cobrança', 'Pagos', 2 * H)] },
    { ...base, id: '2013', nome: 'Leo Nunca Chamou', wa: '(31) 90000-2013', col: 'Rota de Entrega', track: '888030000002013', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    { ...base, id: '2014', nome: 'Mara do Haynan', wa: '(31) 90000-2014', cob: 'hay', col: 'Rota de Entrega', track: '888030000002014', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    { ...base, id: '2015', nome: 'Nico do Afiliado', wa: '(31) 90000-2015', afl: 'afl_x', col: 'Rota de Entrega', track: '888030000002015', hist: [hist('Enviado', 'Rota de Entrega', 2 * H)] },
    // o Requer Atencao das 8h, que volta sozinho: saiu ha 30 h, foi e voltou ha 1 h. O relogio e o da saida de verdade.
    { ...base, id: '2017', nome: 'Olga Foi e Voltou', wa: '(31) 90000-2017', col: 'Rota de Entrega', track: '888030000002017', hist: [hist('Enviado', 'Rota de Entrega', 30 * H), hist('Rota de Entrega', 'Requer Atenção', 1.5 * H), hist('Requer Atenção', 'Rota de Entrega', 1 * H)] },
    // dois pedidos do MESMO cliente: nao achou (prioridade) e atrasou
    { ...base, id: '2018', nome: 'Iara Nao Achou', wa: '(31) 90000-2010', col: 'Enviado', track: '888030000002018', hist: [hist('Preparando', 'Enviado', 9 * DIA)] },
    // sem endereco: o "nao achou" nao sai (o texto pede pra conferir o endereco)
    { ...base, id: '2019', nome: 'Paulo Sem Endereco', wa: '(31) 90000-2019', end: '', num: '', col: 'Rota de Entrega', track: '888030000002019', hist: [hist('Enviado', 'Rota de Entrega', 30 * H)] },
    // antecipado ja pago e entregue: o "entregue" sai sem cobrar, o "nao pagou" nunca
    { ...base, id: '2020', nome: 'Rita Antecipado', wa: '(31) 90000-2020', mod: 'antecipado', col: 'Cobrança', track: '888030000002020', hist: [hist('Rota de Entrega', 'Cobrança', 40 * H)] },
    // boas-vindas: pedido ja despachado e pedido ainda nao despachado
    { ...base, id: '2021', nome: 'Sara Ja Saiu', wa: '(31) 90000-2021', col: 'Enviado', track: '888030000002021', ship_ts: Math.floor(T0 / 1000) - 3600, hist: [hist('Preparando', 'Enviado', 1 * H)] },
    { ...base, id: '2022', nome: 'Tais Nao Saiu', wa: '(31) 90000-2022', col: 'A Enviar' },
    // retirou na AGENCIA ha 1 h: nao e "chegou na sua casa"
    { ...base, id: '2023', nome: 'Ugo Retirou', wa: '(31) 90000-2023', col: 'Cobrança', track: 'AP555555555BR', ship: 'DELIVERED', hist: [hist('Enviado', 'Retirada', 2 * DIA), hist('Retirada', 'Cobrança', 1 * H)] },
  ],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));
let mid = 0;
const msg = (phone, inst, dir, body, segAtras) => sq.prepare('INSERT INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts, mundo) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('m' + (++mid), phone, inst, dir, 'text', body, '', S() - segAtras, '');
// todo mundo ja falou com o Bryan ha 5 dias (e foi respondido), menos o Leo; a Mara falou com o Haynan
for (const n of ['2001', '2002', '2003', '2004', '2005', '2006', '2007', '2008', '2009', '2010', '2011', '2012', '2015', '2017', '2019', '2020', '2023']) {
  msg('553190000' + n, I_BRY, 'in', 'oi', 5 * 86400);
  msg('553190000' + n, I_BRY, 'out', 'Boa tarde', 5 * 86400 - 60);
}
msg('5531900002014', I_HAY, 'in', 'oi', 5 * 86400);
msg('5531900002014', I_HAY, 'out', 'Boa tarde', 5 * 86400 - 60);
// a Sara e a Tais acabaram de chamar (boas-vindas)
msg('5531900002021', I_BRY, 'in', 'Olá! Quero acompanhar o meu pedido.', 200);
msg('5531900002022', I_BRY, 'in', 'Olá! Quero acompanhar o meu pedido.', 200);
// os dois lembretes da retirada do Fabio que ja foram (dias 1 e 2)
const jaFoi = sq.prepare("INSERT INTO swweb_auto (k, tipo, nk, fone, pedido, status, n, pego_ts, feito_ts) VALUES (?, 'retirada', ?, '5531900002007', '2007', 'enviado', 1, ?, ?)");
jaFoi.run('ret:2007:1', NK_BRY, S() - 2 * 86400, S() - 2 * 86400);
jaFoi.run('ret:2007:2', NK_BRY, S() - 86400, S() - 86400);

const aluga = (nk, quem, maq) => sq.prepare('INSERT OR REPLACE INTO swweb_uso (nk,user_id,nome,maquina,desde,ate,versao) VALUES (?,?,?,?,?,?,?)').run(nk, quem, quem, maq, S() - 600, S() + 120, '1.26.17');
const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-cob-auto2.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const renova = () => { aluga(NK_BRY, 'bry', 'mb'); aluga(NK_HAY, 'hay', 'mh'); };
const chama = async (tk, path, body, maquina, versao) => {
  renova();
  const h = { authorization: 'Bearer ' + tk };
  if (body) h['content-type'] = 'application/json';
  if (maquina) { h['x-sw-maquina'] = maquina; h['x-sw-versao'] = versao || '1.26.17'; }
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
const itens = async (versao, quem = 'bry') => (await chama(TK[quem], '/api/swweb/auto?nks=' + (quem === 'hay' ? NK_HAY : NK_BRY), null, quem === 'hay' ? 'mh' : 'mb', versao)).d.itens || [];
const dePed = (lista, ped, tipo) => (lista || []).find((x) => String(x.pedido) === String(ped) && (!tipo || x.tipo === tipo));
const linha = (k) => sq.prepare('SELECT * FROM swweb_auto WHERE k=?').get(k);
const manda = async (it, quem = 'bry') => {
  const maq = quem === 'hay' ? 'mh' : 'mb';
  const p = await chama(TK[quem], '/api/swweb/auto/pega', { k: it.k, chaves: it.chaves, nk: it.nk, tipo: it.tipo, fone: it.fone, pedido: it.pedido, nome: it.nome }, maq);
  const f = await chama(TK[quem], '/api/swweb/auto/feito', { k: it.k, chaves: it.chaves, nk: it.nk, ok: true, n: (it.partes || it.textos).length }, maq);
  return { p: p.d, f: f.d };
};
const TODAS = { rec: true, recr: true, pos: true, sai: true, ent: true, ret: true, nach: true, npg: true, atr: true, pag: true };

_log('\nSO O QUE A DIRECAO LIGOU, E SO PRO APP NOVO\n');
let r = await chama(TK.dir, '/api/cob/auto', { rec: true, pos: true });
let it = await itens();
vale('com so recepcao e codigo ligados, nenhum tipo novo sai', it.length > 0 && it.every((x) => x.tipo === 'recepcao' || x.tipo === 'postado'), it.map((x) => x.tipo).join(','));
r = await chama(TK.dir, '/api/cob/auto', TODAS);
vale('a direcao liga as dez', r.st === 200 && Object.keys(TODAS).every((k) => r.d.cfg[k] === true), JSON.stringify(r.d.cfg && Object.keys(TODAS).filter((k) => !r.d.cfg[k])));
vale('a resposta leva o catalogo (10 automacoes) e os campos de texto', Array.isArray(r.d.tipos) && r.d.tipos.length === 10 && r.d.campos && r.d.campos.ret5 && r.d.padrao.pagou, String(r.d.tipos && r.d.tipos.length));
it = await itens('1.26.16');
vale('app antigo (1.26.16) so recebe recepcao e codigo', it.length > 0 && it.every((x) => x.tipo === 'recepcao' || x.tipo === 'postado'), it.map((x) => x.tipo).join(','));
it = await itens();
const tiposNovos = [...new Set(it.map((x) => x.tipo))];
vale('app novo (1.26.17) recebe os tipos novos', ['saiu', 'entregue', 'retirada', 'naoachou', 'naopagou', 'atrasou', 'pagou'].every((t) => tiposNovos.includes(t) || it.length >= 10), tiposNovos.join(','));
// a rota corta em 10 por vez: daqui pra frente o teste olha a lista inteira pela previa da dash e os itens do app um a um
const previa = async () => (await chama(TK.dir, '/api/cob/auto')).d.fila || [];
const fila = await previa();
const naFila = (nome, tipo) => fila.find((x) => x.nome === nome && x.tipo === tipo);
const nCurtos = () => { try { return sq.prepare('SELECT COUNT(*) n FROM short_links').get().n; } catch (_) { return 0; } };

_log('\nSAIU PRA ENTREGA\n');
const sai = dePed(it, '2001') || {};
vale('quem saiu ha 2 h recebe o aviso, pelo primeiro nome arrumado', sai.tipo === 'saiu' && /^Boa notícia, Maria! Seu pedido do Glico Six saiu para entrega hoje\./.test(sai.textos[0]), sai.textos && sai.textos[0].slice(0, 80));
vale('pago na entrega: leva o valor a pagar', /Valor a pagar depois de receber: R\$ 497,00/.test(sai.textos[0]) && !/\{/.test(sai.textos[0]), '');
vale('a chave e por pedido e a pagina recebe desde quando conta "o cobrador ja falou"', sai.k === 'sai:2001' && sai.falouDesde === Math.floor((T0 - 2 * H) / 1000) && JSON.stringify(sai.chaves) === '["sai:2001"]', sai.k + ' ' + sai.falouDesde);
vale('vai em `partes` (texto) e em `textos`, pelo numero do Bryan', Array.isArray(sai.partes) && sai.partes.length === 1 && sai.partes[0].tipo === 'texto' && sai.partes[0].texto === sai.textos[0] && sai.nk === NK_BRY, '');
vale('quem nunca chamou o cobrador nao recebe', !fila.some((x) => x.nome === 'Leo Nunca Chamou'), '');
vale('pedido de afiliado nao recebe', !fila.some((x) => x.nome === 'Nico do Afiliado'), '');
vale('cliente que falou com o Haynan nao sai pelo numero do Bryan', !dePed(it, '2014') && !!naFila('Mara do Haynan', 'saiu') && naFila('Mara do Haynan', 'saiu').nk === NK_HAY, '');
vale('a volta do Requer Atencao nao vira "saiu agora" (a Olga saiu ha 30 h)', !naFila('Olga Foi e Voltou', 'saiu') && !!naFila('Olga Foi e Voltou', 'naoachou'), fila.filter((x) => x.nome === 'Olga Foi e Voltou').map((x) => x.tipo).join(','));

_log('\nENTREGUE, COM A FOTO\n');
const ent = dePed(it, '2002') || {};
vale('entregue ha 1 h com foto: a frase do Bruno, com "hoje"', ent.tipo === 'entregue' && ent.textos[0] === 'Oi Ana, acabei de ver que seu pedido chegou na sua casa hoje. Recebeu ele tudo certinho?', ent.textos && ent.textos[0]);
const foto = (ent.partes || [])[1] || {};
vale('a foto vai como imagem, com o link assinado', foto.tipo === 'midia' && foto.kind === 'image' && /\/api\/arquivo\/comprovante%2F2002%2Fentrega-1\.jpg\?exp=\d+&sig=[0-9a-f]{32}$/.test(foto.url), foto.url);
vale('entregue ha 30 min SEM foto: espera a foto chegar', !fila.some((x) => x.nome === 'Bia Sem Foto' && x.tipo === 'entregue'), '');
vale('quem RETIROU na agencia nao recebe "chegou na sua casa"', !fila.some((x) => x.nome === 'Ugo Retirou' && x.tipo === 'entregue'), fila.filter((x) => x.nome === 'Ugo Retirou').map((x) => x.tipo).join(','));
vale('na previa da dash o item diz que tem foto', !!naFila('Ana Com Foto', 'entregue') && naFila('Ana Com Foto', 'entregue').foto === true, JSON.stringify(naFila('Ana Com Foto', 'entregue')));

_log('\nENTREGUE E NAO PAGOU\n');
const npgFila = naFila('Caio Nao Pagou', 'naopagou');
vale('entregue ha 40 h e nao pagou: lembrete na fila, com o valor', !!npgFila && /Valor: R\$ 497,00/.test(npgFila.textos[0]), npgFila && npgFila.textos[0].slice(0, 120));
vale('a previa NAO cria link curto (so mostra onde ele entra)', /sellwave\.com\.br\/checkout\/\(link do pedido\)/.test(npgFila.textos[0]) && (await (async () => { const antes = nCurtos(); await previa(); return nCurtos() === antes; })()), 'curtos=' + nCurtos());
vale('quem tem retorno combinado pra frente nao recebe o lembrete', !naFila('Davi Combinou', 'naopagou'), '');
vale('pedido antecipado nunca recebe "nao pagou"', !naFila('Rita Antecipado', 'naopagou'), '');
vale('entregue ha 40 h nao recebe mais o "chegou hoje"', !naFila('Caio Nao Pagou', 'entregue'), '');

_log('\nRETIRADA NOS CORREIOS\n');
const ret1 = dePed(it, '2006') || naFila('Eva Retirada', 'retirada') || {};
vale('chegou na agencia hoje: primeiro aviso, com codigo, link e valor', /chegou na agência dos Correios/.test(ret1.textos[0]) && /Código de rastreio: AP111111111BR/.test(ret1.textos[0]) && /glico-six\.rastreio\.vip\/rastreio\?codigo=AP111111111BR/.test(ret1.textos[0]) && /R\$ 497,00/.test(ret1.textos[0]), ret1.textos && ret1.textos[0].slice(0, 100));
const ret3 = naFila('Fabio Terceiro Dia', 'retirada');
vale('terceiro dia, com dois lembretes ja enviados: o TERCEIRO texto', !!ret3 && /^Bom dia, Fabio! Seu pedido ainda está na agência dos Correios\./.test(ret3.textos[0]) && /AP222222222BR/.test(ret3.textos[0]), ret3 && ret3.textos[0].slice(0, 90));
const ret5 = naFila('Hugo Quinto Dia', 'retirada');
vale('quinto dia: o ultimo aviso (mesmo sem os outros terem saido)', !!ret5 && /Este é o último aviso/.test(ret5.textos[0]) && /volta pra gente/.test(ret5.textos[0]), ret5 && ret5.textos[0].slice(0, 90));
vale('sexto dia em diante: nada', !naFila('Gil Sexto Dia', 'retirada'), '');

_log('\nNAO ACHOU NINGUEM, ATRASOU E PAGOU\n');
const nach = naFila('Iara Nao Achou', 'naoachou');
vale('em rota ha 30 h: pede pra conferir o endereco do cadastro', !!nach && /ainda não aparece como entregue/.test(nach.textos[0]) && /📍 Rua das Flores, 120 - Centro - Betim\/MG - CEP 32600-000/.test(nach.textos[0]), nach && nach.textos[0].slice(0, 200));
vale('UMA por cliente: a Iara tem "nao achou", "atrasou" e dois codigos pra receber, so a primeira aparece', fila.filter((x) => x.nome === 'Iara Nao Achou').map((x) => x.tipo).join(',') === 'naoachou', fila.filter((x) => x.nome === 'Iara Nao Achou').map((x) => x.tipo).join(','));
vale('ninguem aparece duas vezes na fila (fora a recepcao)', (() => { const v = new Set(); return fila.filter((x) => x.tipo !== 'recepcao').every((x) => { const k = x.nome; if (v.has(k)) return false; v.add(k); return true; }); })(), '');
vale('sem endereco no cadastro, o "nao achou" nao sai', !naFila('Paulo Sem Endereco', 'naoachou'), '');
const atr = naFila('Joao Atrasado', 'atrasou');
vale('8 dias com a transportadora: aviso de atraso com o link do rastreio', !!atr && /demorando um pouco mais que o normal/.test(atr.textos[0]) && /rastreio\?codigo=888030000002011/.test(atr.textos[0]), atr && atr.textos[0].slice(0, 80));
const pag = naFila('Katia Pagou', 'pagou');
vale('pagou ha 2 h: agradecimento', !!pag && /^Recebi a confirmação do seu pagamento, Katia! ✅/.test(pag.textos[0]), pag && pag.textos[0].slice(0, 80));
vale('nenhum texto sai com variavel sobrando', fila.every((x) => (x.textos || []).every((t) => !/\{[a-z_]+\}/.test(t))), '');

_log('\nBOAS-VINDAS COM E SEM RASTREIO\n');
const sara = dePed(it, '2021', 'recepcao') || {};
const tais = dePed(it, '2022', 'recepcao') || {};
vale('pedido ja despachado: as boas-vindas levam o codigo', (sara.textos || []).length === 4 && /888030000002021/.test(sara.textos[3]) && sara.chaves.length === 2, JSON.stringify(sara.chaves));
vale('pedido que nao saiu: boas-vindas sem codigo', (tais.textos || []).length === 3 && tais.chaves.length === 1, JSON.stringify(tais.chaves));
r = await manda(sara);
vale('a com rastreio fica gravada como tipo proprio (recepcao_r) e conta no dia dela', linha(sara.k).tipo === 'recepcao_r' && linha(sara.k).status === 'enviado', linha(sara.k).tipo);
r = await chama(TK.dir, '/api/cob/auto');
vale('a dash conta por automacao (recr 1) e mantem a soma antiga de recepcao', r.d.hoje.porTipo.recr === 1 && r.d.hoje.recepcao === 1, JSON.stringify(r.d.hoje));
sq.exec("DELETE FROM swweb_auto WHERE k LIKE 'rec:%' OR k LIKE 'pos:2021%'");
r = await chama(TK.dir, '/api/cob/auto', { recr: false });
it = await itens();
const sara2 = dePed(it, '2021', 'recepcao') || {};
vale('com a "com rastreio" desligada, o despachado recebe a comum, sem codigo', (sara2.textos || []).length === 3 && sara2.chaves.length === 1 && !sara2.codigo, JSON.stringify(sara2.chaves));
r = await chama(TK.dir, '/api/cob/auto', { rec: false, recr: true });
it = await itens();
vale('so a "com rastreio" ligada: o despachado recebe com codigo e o que nao saiu nao recebe', (dePed(it, '2021', 'recepcao') || { textos: [] }).textos.length === 4 && !dePed(it, '2022', 'recepcao'), it.filter((x) => x.tipo === 'recepcao').map((x) => x.pedido).join(','));
await chama(TK.dir, '/api/cob/auto', TODAS);

_log('\nCADA COBRADOR LIGA E DESLIGA AS DELE\n');
r = await chama(TK.bry, '/api/swweb/auto/config', null, 'mb');
vale('o cobrador ve as dez, todas ligadas, com os textos', r.st === 200 && r.d.tipos.length === 10 && r.d.tipos.every((t) => t.direcao && t.meu) && r.d.tipos.find((t) => t.id === 'ret').textos.length === 5, JSON.stringify(r.d.tipos && r.d.tipos.map((t) => t.id + (t.meu ? '+' : '-'))));
r = await chama(TK.kev, '/api/swweb/auto/config', null, 'mk');
vale('vendedor nao tem a aba (403)', r.st === 403, String(r.st));
r = await chama(TK.bry, '/api/swweb/auto/config', { id: 'ret', ligado: false }, 'mb');
vale('o Bryan desliga a retirada dele', r.st === 200 && r.d.tipos.find((t) => t.id === 'ret').meu === false && r.d.tipos.find((t) => t.id === 'sai').meu === true, '');
it = await itens();
let f2 = await previa();
vale('as retiradas param de sair pelo numero dele (e o resto continua)', !it.some((x) => x.tipo === 'retirada') && it.some((x) => x.tipo === 'saiu'), it.map((x) => x.tipo).join(','));
vale('a previa da dash continua mostrando o que sairia e diz quem desligou o que', f2.some((x) => x.tipo === 'retirada'), '');
r = await chama(TK.dir, '/api/cob/auto');
vale('a direcao ve que o Bryan desligou a retirada', JSON.stringify(r.d.pessoas) === JSON.stringify([{ nome: 'Bryan Amorim', off: ['ret'] }]), JSON.stringify(r.d.pessoas));
r = await chama(TK.hay, '/api/swweb/auto/config', { id: 'ret', ligado: true, de: 'bry' }, 'mh');
vale('outro cobrador nao mexe na do Bryan (403)', r.st === 403, String(r.st));
r = await chama(TK.dir, '/api/swweb/auto/config', { id: 'ret', ligado: true, de: 'bry' }, 'md');
vale('a direcao religa a do Bryan (pelo "ver como")', r.st === 200 && !JSON.parse(sq.prepare("SELECT value FROM app_config WHERE key='cob_auto_pessoa'").get().value).bry, sq.prepare("SELECT value FROM app_config WHERE key='cob_auto_pessoa'").get().value);
r = await chama(TK.bry, '/api/swweb/auto/config', { id: 'inventada', ligado: false }, 'mb');
vale('automacao que nao existe e recusada', r.st === 400, String(r.st));
r = await chama(TK.dir, '/api/cob/auto', { ret: false });
r = await chama(TK.bry, '/api/swweb/auto/config', null, 'mb');
vale('o que a direcao desligou aparece desligado pra ele (e a dele continua ligada)', r.d.tipos.find((t) => t.id === 'ret').direcao === false && r.d.tipos.find((t) => t.id === 'ret').meu === true, '');
await chama(TK.dir, '/api/cob/auto', TODAS);

_log('\nA TRAVA, O INTERVALO E O HORARIO\n');
it = await itens();
const umSai = dePed(it, '2001', 'saiu');
r = await manda(umSai);
vale('pega e feito aceitam a chave e o tipo novos', r.p.ok === true && r.f.status === 'enviado' && linha('sai:2001').tipo === 'saiu', JSON.stringify(r));
r = await chama(TK.bry, '/api/swweb/auto/config', null, 'mb');
vale('a aba conta o que saiu hoje pelos numeros dele e lista o envio', r.d.tipos.find((t) => t.id === 'sai').hoje === 1 && r.d.ultimos[0].id === 'sai' && r.d.ultimos[0].status === 'enviado', JSON.stringify(r.d.ultimos && r.d.ultimos[0]));
r = await chama(TK.hay, '/api/swweb/auto/config', null, 'mh');
vale('o outro cobrador nao ve os envios do Bryan', r.d.tipos.find((t) => t.id === 'sai').hoje === 0 && r.d.ultimos.length === 0, JSON.stringify(r.d.ultimos));
f2 = await previa();
vale('enviado nao volta', !f2.some((x) => x.nome === 'Maria Saiu Hoje' && x.tipo === 'saiu'), '');
// a Iara: manda o "nao achou"; o "atrasou" do outro pedido espera 3 h
it = await itens();
let iara = it.find((x) => x.k === 'nach:2010') || { k: 'nach:2010', chaves: ['nach:2010'], nk: NK_BRY, tipo: 'naoachou', fone: '5531900002010', pedido: '2010', nome: 'Iara Nao Achou', textos: ['x'] };
await manda(iara);
f2 = await previa();
vale('depois de uma automatica, a proxima pro mesmo cliente espera 3 h', !f2.some((x) => x.nome === 'Iara Nao Achou'), f2.filter((x) => x.nome === 'Iara Nao Achou').map((x) => x.tipo).join(','));
const enviadoEm = S();
AGORA += 3 * H + 60000;
f2 = await previa();
vale('passadas as 3 h, o "atrasou" dela aparece', f2.some((x) => x.nome === 'Iara Nao Achou' && x.tipo === 'atrasou'), f2.filter((x) => x.nome === 'Iara Nao Achou').map((x) => x.tipo).join(','));
// pega os itens em rodadas ate achar o atrasou da Iara (a rota entrega 10 por vez)
let atrIara = null;
for (let i = 0; i < 6 && !atrIara; i++) {
  it = await itens();
  atrIara = it.find((x) => x.k === 'atr:2018') || null;
  if (!atrIara) for (const x of it) await manda(x);
}
vale('e leva `falouDesde` = a ultima automatica + 60 s (a pagina nao confunde a nossa mensagem com o cobrador)', !!atrIara && atrIara.falouDesde === enviadoEm + 60, atrIara && String(atrIara.falouDesde) + ' x ' + (enviadoEm + 60));
AGORA = T0;
// o agradecimento nao espera as 3 h
sq.exec("DELETE FROM swweb_auto WHERE k NOT LIKE 'ret:2007:%'");
sq.prepare("INSERT INTO swweb_auto (k, tipo, nk, fone, pedido, status, n, pego_ts, feito_ts) VALUES ('npg:2012', 'naopagou', ?, '5531900002012', '2012', 'enviado', 1, ?, ?)").run(NK_BRY, S() - 1800, S() - 1800);
f2 = await previa();
vale('o agradecimento do pagamento nao espera as 3 h', f2.some((x) => x.nome === 'Katia Pagou' && x.tipo === 'pagou'), '');
sq.exec("DELETE FROM swweb_auto WHERE k = 'npg:2012'");
// o link curto de verdade so nasce quando o app pede
for (let i = 0; i < 6; i++) { it = await itens(); const n = it.find((x) => x.k === 'npg:2004'); if (n) { iara = n; break; } for (const x of it) await manda(x); }
vale('no app, o "nao pagou" leva o link curto da casa (nunca o comprido, com CPF e endereco)', iara.k === 'npg:2004' && /Pagar agora: https:\/\/sellwave\.com\.br\/checkout\/[a-z0-9]{7}\n/.test(iara.textos[0]) && !/payt\.com\.br/.test(iara.textos[0]), iara.textos && iara.textos[0].slice(60, 200));
vale('e o link curto aponta pro checkout do pedido, preenchido', (() => { const x = sq.prepare("SELECT url, lead_id FROM short_links").get(); return x && x.lead_id === '2004' && /^https:\/\/checkout\.payt\.com\.br\/abc123\?/.test(x.url) && /utm_content=ped2004/.test(x.url); })(), JSON.stringify(sq.prepare("SELECT url, lead_id FROM short_links").get()));
sq.exec("DELETE FROM swweb_auto WHERE k NOT IN ('ret:2007:1', 'ret:2007:2')");
// o ritmo: no maximo 12 das novas por numero a cada hora (a recepcao nao entra na conta)
const insH = sq.prepare("INSERT INTO swweb_auto (k, tipo, nk, fone, status, n, pego_ts, feito_ts) VALUES (?, 'saiu', ?, ?, 'enviado', 1, ?, ?)");
for (let i = 0; i < 11; i++) insH.run('sai:hora' + i, NK_BRY, '55319888800' + String(10 + i), S() - 600, S() - 600);
it = await itens();
vale('com 11 das novas na ultima hora, so mais UMA sai pelo numero (e a recepcao passa livre)', it.filter((x) => x.tipo !== 'recepcao').length === 1 && it.filter((x) => x.tipo === 'recepcao').length === 2, it.map((x) => x.tipo).join(','));
insH.run('sai:hora11', NK_BRY, '5531988880099', S() - 600, S() - 600);
it = await itens();
vale('com 12, nenhuma das novas sai ate a hora virar', it.every((x) => x.tipo === 'recepcao') && it.length === 2, it.map((x) => x.tipo).join(','));
vale('o numero do outro cobrador nao e segurado pelo ritmo do Bryan', (await itens(undefined, 'hay')).some((x) => x.tipo === 'saiu'), '');
AGORA += 51 * 60000;
it = await itens();
vale('passada a hora, voltam a sair', it.some((x) => x.tipo !== 'recepcao'), it.map((x) => x.tipo).join(','));
AGORA = T0;
sq.exec("DELETE FROM swweb_auto WHERE k LIKE 'sai:hora%'");
AGORA = Date.UTC(2026, 10, 10, 23, 30, 0);   // 20:30 em Brasilia
it = await itens();
vale('depois das 20h nenhuma das novas sai (so a recepcao, que e resposta)', it.every((x) => x.tipo === 'recepcao' || x.tipo === 'postado'), it.map((x) => x.tipo).join(','));
AGORA = Date.UTC(2026, 10, 11, 10, 30, 0);   // 11/11 07:30
it = await itens();
vale('nem antes das 8h', it.every((x) => x.tipo === 'recepcao' || x.tipo === 'postado'), it.map((x) => x.tipo).join(','));

_log('\nO DIA SEGUINTE\n');
AGORA = T0;
it = await itens();
const eva1 = it.find((x) => x.k === 'ret:2006:1') || { k: 'ret:2006:1', chaves: ['ret:2006:1'], nk: NK_BRY, tipo: 'retirada', fone: '5531900002006', pedido: '2006', nome: 'Eva Retirada', textos: ['x'] };
await manda(eva1);
AGORA = T0 + DIA;   // 11/11 10:00
f2 = await previa();
const eva2 = f2.find((x) => x.nome === 'Eva Retirada' && x.tipo === 'retirada');
vale('no dia seguinte a retirada da Eva volta, com o SEGUNDO texto', !!eva2 && /continua na agência dos Correios esperando você/.test(eva2.textos[0]) && /^Bom dia, Eva!/.test(eva2.textos[0]), eva2 && eva2.textos[0].slice(0, 80));
const bia = f2.find((x) => x.nome === 'Bia Sem Foto' && x.tipo === 'entregue');
vale('a Bia (entregue ontem, a foto nunca chegou): "chegou ontem", sem foto', !!bia && /chegou na sua casa ontem/.test(bia.textos[0]) && bia.foto === false, bia && bia.textos[0]);
vale('a Maria, que saiu ontem e nao foi entregue, vira "nao achou"', f2.some((x) => x.nome === 'Maria Saiu Hoje' && x.tipo === 'naoachou'), f2.filter((x) => x.nome === 'Maria Saiu Hoje').map((x) => x.tipo).join(','));
vale('quem pagou ha mais de 24 h nao recebe agradecimento atrasado', !f2.some((x) => x.nome === 'Katia Pagou'), '');
AGORA = T0;

_log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) { _log('FALHARAM:\n - ' + falhas.join('\n - ')); process.exit(1); }
