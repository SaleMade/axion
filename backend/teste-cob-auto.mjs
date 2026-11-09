// AS MENSAGENS AUTOMATICAS DOS NUMEROS DE COBRANCA NA ROTA DE VERDADE (09/11/2026). Roda o worker
// inteiro (bundle do wrangler) contra um D1 de mentira e prova as regras do _cobAutoItens e as rotas:
//
//  RECEPCAO: so quem escreveu num numero de cobrador nas ultimas 72 h, nunca foi respondido por
//    numero de cobrador, ja faz 60 s, e pediu pra acompanhar o pedido ou tem pedido nosso. Os textos
//    (saudacao com o nome do pedido, apresentacao, "Localizei" com o valor so pra pago na entrega
//    ainda nao entregue, codigo junto quando ja saiu).
//  POSTADO: pedido da casa a caminho, com codigo, que andou nos ultimos 10 dias, cliente que ja falou
//    com cobrador, codigo nunca mandado por numero nosso; sai pelo numero em que ele falou por ultimo,
//    so das 8h as 21h.
//  AS TRAVAS: aluguel desta maquina, pega uma vez so, falhou sem sair volta ate 3 vezes, pulado solta
//    o codigo, teto de 150 por numero, desligado por padrao, numero nosso e afiliado de fora.
//  A TELA DA DASH: so a direcao da casa; liga, desliga e troca o texto; mostra a fila e o dia.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-cob-auto.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-cob-auto.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER, versao TEXT)');
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
let AGORA = Date.UTC(2026, 10, 10, 13, 0, 0);
Date.now = () => AGORA;
const _log = console.log;
const logs = [];
console.log = (...a) => { logs.push(a.join(' ')); };

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

const S = () => Math.floor(AGORA / 1000);
const usuarios = [
  ['dir', 'Diretor', 'diretor', null], ['bry', 'Bryan Amorim', 'cobrador', null], ['hay', 'Haynan', 'cobrador', null],
  ['kev', 'Kevin Marques', 'atendente', null], ['acob', 'Cobrador do Afiliado', 'cobrador', 'afl_x'],
];
for (const [id, nome, role, afl] of usuarios) {
  sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role);
  sq.prepare('UPDATE users SET afiliado_id=?, archived=0 WHERE id=?').run(afl, id);
}
const TK = { dir: 'd'.repeat(64), bry: 'b'.repeat(64), hay: 'c'.repeat(64), kev: 'e'.repeat(64), acob: 'f'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, S() + 30 * 86400);

const NK_BRY = '1127335679', NK_HAY = '1591980514', NK_ACOB = '4198880000';
const I_BRY = 'ax_bry_27335679', I_HAY = 'ax_hay_91980514', I_KEV = 'ax_kev_97973450';
const histBr = (msAtras) => {
  const d = new Date(AGORA - msAtras - 3 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
};
const DIA = 86400000;
const estado = {
  wa_statuses: [{ id: 'st_uso', label: 'Em uso', papel: 'em_uso' }],
  chips: [
    { id: 'c1', num: '(11) 92733-5679', at: 'bry', em_uso: true, st: 'ativo' },
    { id: 'c2', num: '(15) 99198-0514', at: 'hay', em_uso: true, st: 'ativo' },
    { id: 'c3', num: '(15) 99797-3450', at: 'kev', em_uso: true, st: 'ativo' },
    { id: 'c4', num: '(41) 99888-0000', at: 'acob', afl: 'afl_x', st: 'ativo' },
  ],
  pressels: [],
  leads: [
    { id: '1001', nome: 'MARIA DAS DORES', wa: '(31) 99876-5432', vl: 497, col: 'A Enviar', mod: 'entrega', at: 'kev', cob: 'bry' },
    { id: '1002', nome: 'joao pedro', wa: '(21) 99666-5555', vl: 397, col: 'Enviado', mod: 'entrega', track: '888031000000001', ship: 'IN_TRANSIT', ship_ts: S() - 3600, at: 'kev', cob: 'bry' },
    { id: '1003', nome: 'Ana Entregue', wa: '(41) 99555-4444', vl: 497, col: 'Cobrança', mod: 'entrega', track: '888031000000003', ship: 'DELIVERED', ship_ts: S() - 7200, at: 'kev', cob: 'bry' },
    { id: '1004', nome: 'Pedro Antecipado', wa: '(51) 99444-3333', vl: 297, col: 'A Enviar', mod: 'antecipado', spg: 'Pago', at: 'kev', cob: 'bry' },
    { id: '1005', nome: 'Lucas Parado', wa: '(61) 99333-2222', vl: 497, col: 'Enviado', track: 'AP123456789BR', ship_ts: S() - 15 * 86400, hist: [{ from: 'A Enviar', to: 'Enviado', time: histBr(15 * DIA) }], at: 'kev', cob: 'bry' },
    { id: '1006', nome: 'Carla do Haynan', wa: '(71) 99222-1111', vl: 497, col: 'Enviado', track: '888031000000006', ship_ts: S() - 2 * 86400, at: 'kev', cob: 'hay' },
    { id: '1007', nome: 'Beto Ja Recebeu', wa: '(81) 99111-0000', vl: 497, col: 'Enviado', track: '888031000000007', ship_ts: S() - 86400, at: 'kev', cob: 'bry' },
    { id: '1008', nome: 'Dani Nunca Chamou', wa: '(91) 99000-1111', vl: 497, col: 'Enviado', track: '888031000000008', ship_ts: S() - 86400, at: 'kev', cob: 'bry' },
    { id: '1009', nome: 'Cliente do Afiliado', wa: '(11) 98000-2222', vl: 497, col: 'Enviado', track: '888031000000009', ship_ts: S() - 86400, at: 'kev', afl: 'afl_x' },
    { id: '1010', nome: 'Eva dos Santos', wa: '(31) 98111-3333', vl: 497, col: 'Rota de Entrega', track: '888031000000010', hist: [{ from: 'Enviado', to: 'Rota de Entrega', time: histBr(2 * 3600000) }], at: 'kev', cob: 'bry' },
  ],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));
let mid = 0;
const msg = (phone, inst, dir, body, segAtras, push) => sq.prepare('INSERT INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts, mundo) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('m' + (++mid), phone, inst, dir, 'text', body, push || '', S() - segAtras, '');
const ACOMP = 'Olá! Quero acompanhar o meu pedido.';
msg('5531998765432', I_BRY, 'in', ACOMP, 120, 'Maria');                         // C1: pedido A Enviar
msg('5511912340000', I_BRY, 'in', ACOMP, 300, '😀❤️');                           // sem pedido, nome so emoji
msg('5511912340001', I_BRY, 'in', '*Sua fatura de credito esta em atraso*', 300, 'Banco');   // nao e cliente nosso
msg('552196665555', I_BRY, 'in', 'Quero acompanhar meu pedido', 200, 'Joao');   // C2 (sem o 9): pedido ja saiu
msg('5541995554444', I_BRY, 'in', 'oi', 500, 'Ana');                             // pedido entregue
msg('5551994443333', I_BRY, 'in', ACOMP, 400, 'Pedro');                          // antecipado
msg('5511912340009', I_BRY, 'in', ACOMP, 30, 'Recente');                         // escreveu agora
msg('5511912340010', I_BRY, 'in', ACOMP, 4 * 86400, 'Velho');                    // fora da janela
msg('5511912340011', I_BRY, 'in', ACOMP, 600, 'Ja Respondido');                  // ja respondido pelo outro cobrador
msg('5511912340011', I_HAY, 'out', 'Boa tarde', 2 * 86400);
msg('5515997973450', I_BRY, 'in', ACOMP, 700, 'Kevin');                          // numero nosso
msg('5571992221111', I_HAY, 'in', 'oi', 5 * 86400, 'Carla');                     // Carla: falou com o Haynan
msg('5571992221111', I_HAY, 'out', 'Bom dia', 5 * 86400 - 60);
msg('5581991110000', I_BRY, 'in', 'ok', 3 * 86400, 'Beto');                      // Beto: codigo ja foi pelo vendedor
msg('5581991110000', I_BRY, 'out', 'Boa tarde', 3 * 86400 - 60);
msg('5581991110000', I_KEV, 'out', 'Seu codigo: 888031000000007', 86400);
msg('5531981113333', I_HAY, 'in', 'oi', 6 * 86400, 'Eva');                       // Eva: Haynan antes, Bryan depois
msg('5531981113333', I_HAY, 'out', 'oi', 6 * 86400 - 60);
msg('5531981113333', I_BRY, 'in', 'chegou?', 86400, 'Eva');
msg('5531981113333', I_BRY, 'out', 'vou ver', 86400 - 60);
msg('5561993332222', I_BRY, 'in', 'oi', 20 * 86400, 'Lucas');                    // Lucas: envio parado ha 15 dias
msg('5561993332222', I_BRY, 'out', 'oi', 20 * 86400 - 60);
msg('5511980002222', I_BRY, 'in', 'oi', 2 * 86400, 'Afl');                       // pedido do afiliado
msg('5511980002222', I_BRY, 'out', 'oi', 2 * 86400 - 60);
const aluga = (nk, quem, maq) => sq.prepare('INSERT OR REPLACE INTO swweb_uso (nk,user_id,nome,maquina,desde,ate,versao) VALUES (?,?,?,?,?,?,?)').run(nk, quem, quem, maq, S() - 600, S() + 120, '1.26.14');
aluga(NK_BRY, 'bry', 'mb');
aluga(NK_HAY, 'dir', 'mh');
aluga(NK_ACOB, 'acob', 'ma');

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-cob-auto.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const renova = () => { aluga(NK_BRY, 'bry', 'mb'); aluga(NK_HAY, 'dir', 'mh'); aluga(NK_ACOB, 'acob', 'ma'); };
const chama = async (tk, path, body, maquina) => {
  renova();
  const h = { authorization: 'Bearer ' + tk };
  if (body) h['content-type'] = 'application/json';
  if (maquina) { h['x-sw-maquina'] = maquina; h['x-sw-versao'] = '1.26.14'; }
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
const itensBry = async (maq = 'mb', nks = NK_BRY) => (await chama(TK.bry, '/api/swweb/auto?nks=' + nks, null, maq)).d;
const de = (lista, fone8) => (lista || []).find((x) => String(x.fone).slice(-8) === fone8);
const linha = (k) => sq.prepare('SELECT * FROM swweb_auto WHERE k=?').get(k);

_log('\nDESLIGADO ATE A DIRECAO LIGAR\n');
let r = await chama(TK.bry, '/api/swweb/auto?nks=' + NK_BRY, null, 'mb');
vale('sem configuracao nada sai (e o app pergunta de 5 em 5 min)', r.st === 200 && (r.d.itens || []).length === 0 && r.d.proxima === 300, JSON.stringify(r.d));
r = await chama(TK.bry, '/api/cob/auto', { rec: true, pos: true });
vale('cobrador nao liga (403)', r.st === 403, String(r.st));
r = await chama(TK.kev, '/api/cob/auto');
vale('vendedor nao ve a tela (403)', r.st === 403, String(r.st));
r = await chama(TK.dir, '/api/cob/auto', { rec: true, pos: true });
vale('a direcao liga as duas', r.st === 200 && r.d.cfg && r.d.cfg.rec === true && r.d.cfg.pos === true, JSON.stringify(r.d.cfg && { rec: r.d.cfg.rec, pos: r.d.cfg.pos }));

_log('\nRECEPCAO\n');
let d = await itensBry();
const it = d.itens || [];
const c1 = de(it, '98765432');
vale('cliente que pediu pra acompanhar e tem pedido A Enviar recebe a recepcao completa', !!c1 && c1.tipo === 'recepcao' && c1.textos.length === 3, JSON.stringify(c1 && c1.textos.map((t) => t.slice(0, 30))));
vale('saudacao pela hora com o nome do PEDIDO arrumado ("MARIA DAS DORES" -> "Maria das Dores")', c1 && c1.textos[0] === 'Bom dia Maria das Dores', c1 && c1.textos[0]);
vale('a apresentacao e a do cobrador, palavra por palavra', c1 && /^Aqui quem fala é o Elias sou o rapaz responsável pela parte da entrega e financeira do tratamento da GlicoSix\.$/.test(c1.textos[1]), c1 && c1.textos[1]);
vale('o "Localizei" leva o valor do pedido e o pagamento na entrega', c1 && /R\$ 497,00/.test(c1.textos[2]) && /Pagamento somente na entrega/.test(c1.textos[2]) && !/\{/.test(c1.textos[2]), c1 && c1.textos[2].slice(0, 60));
vale('a chave e o telefone (DDD + 8) e o numero que responde e o do Bryan', c1 && c1.k === 'rec:3198765432' && c1.nk === NK_BRY && c1.pedido === '1001', c1 && (c1.k + ' ' + c1.nk));
const semPed = de(it, '12340000');
vale('sem pedido mas pediu pra acompanhar: saudacao e apresentacao, sem nome (o do WhatsApp era so emoji)', semPed && semPed.textos.length === 2 && semPed.textos[0] === 'Bom dia', semPed && JSON.stringify(semPed.textos.map((t) => t.slice(0, 20))));
vale('mensagem de banco num numero de cobrador nao recebe nada', !de(it, '12340001'), '');
const c2 = de(it, '96665555');
vale('pedido que ja saiu: o codigo vai junto, com o link do rastreador', c2 && c2.textos.length === 4 && /888031000000001/.test(c2.textos[3]) && /glico-six\.rastreio\.vip\/rastreio\?codigo=888031000000001/.test(c2.textos[3]), c2 && c2.textos.length);
vale('e a recepcao pega a chave do Postado daquele pedido junto', c2 && JSON.stringify(c2.chaves) === JSON.stringify(['rec:2196665555', 'pos:1002:888031000000001']) && c2.codigo === '888031000000001', c2 && JSON.stringify(c2.chaves));
vale('valor de outro pedido sai certo (R$ 397,00) e o nome arrumado ("joao pedro" -> "Joao Pedro")', c2 && /R\$ 397,00/.test(c2.textos[2]) && c2.textos[0] === 'Bom dia Joao Pedro', c2 && c2.textos[0]);
const ana = de(it, '95554444');
vale('pedido ja entregue (em cobranca): so saudacao e apresentacao', ana && ana.textos.length === 2 && ana.textos[0] === 'Bom dia Ana Entregue', ana && JSON.stringify(ana.textos.map((t) => t.slice(0, 20))));
const ped = de(it, '94443333');
vale('pedido antecipado: sem o "pagamento somente na entrega"', ped && ped.textos.length === 2, ped && ped.textos.length);
vale('quem escreveu ha 30 s ainda nao recebe (o cobrador tem 1 min)', !de(it, '12340009'), '');
vale('quem escreveu ha 4 dias nao recebe (janela de 72 h)', !de(it, '12340010'), '');
vale('quem ja foi respondido por QUALQUER numero de cobrador nao recebe', !de(it, '12340011'), '');
vale('numero nosso (vendedor) escrevendo pro cobrador nao recebe', !de(it, '97973450'), '');
vale('as recepcoes vem antes dos codigos, da mais antiga pra mais nova', it.findIndex((x) => x.tipo === 'postado') > it.map((x) => x.tipo).lastIndexOf('recepcao') && it.filter((x) => x.tipo === 'recepcao').every((x, i, a) => !i || a[i - 1].desde <= x.desde), it.map((x) => x.tipo[0]).join(''));

_log('\nCODIGO DE RASTREIO (POSTADO)\n');
const eva = de(it, '81113333');
vale('cliente que ja falou com cobrador e o pedido saiu pra entrega: recebe o codigo', eva && eva.tipo === 'postado' && eva.textos.length === 1 && /888031000000010/.test(eva.textos[0]) && eva.k === 'pos:1010:888031000000010', eva && eva.k);
vale('sai pelo numero em que ele falou POR ULTIMO (Bryan, nao o Haynan)', eva && eva.nk === NK_BRY, eva && eva.nk);
vale('texto do codigo sem "o senhor" e sem variavel sobrando', eva && /te aviso\./.test(eva.textos[0]) && !/\{/.test(eva.textos[0]) && !/o senhor/.test(eva.textos[0]), '');
vale('codigo que o vendedor ja mandou nao vai de novo', !de(it, '91110000'), '');
vale('quem nunca chamou o cobrador nao recebe (regra do Bruno)', !de(it, '90001111'), '');
vale('pedido de afiliado nao recebe', !de(it, '80002222'), '');
vale('envio parado ha 15 dias nao vira novidade', !de(it, '93332222'), '');
vale('o pedido do Haynan nao sai pelo numero do Bryan', !de(it, '92221111'), '');
r = await chama(TK.dir, '/api/swweb/auto?nks=' + NK_HAY, null, 'mh');
const carla = de(r.d.itens, '92221111');
vale('na maquina que esta com o numero do Haynan, o codigo da Carla sai por ele', carla && carla.tipo === 'postado' && carla.nk === NK_HAY, JSON.stringify((r.d.itens || []).map((x) => x.k)));

_log('\nAS TRAVAS\n');
r = await chama(TK.bry, '/api/swweb/auto?nks=' + NK_BRY, null, 'mx');
vale('maquina sem o aluguel do numero nao recebe nada', (r.d.itens || []).length === 0 && r.d.proxima === 120, JSON.stringify(r.d).slice(0, 80));
r = await chama(TK.bry, '/api/swweb/auto?nks=' + NK_HAY, null, 'mb');
vale('nem pedindo o numero que esta noutra maquina', (r.d.itens || []).length === 0, '');
r = await chama(TK.acob, '/api/swweb/auto?nks=' + NK_ACOB, null, 'ma');
vale('numero de cobrador de AFILIADO fica de fora', (r.d.itens || []).length === 0, JSON.stringify(r.d).slice(0, 80));
AGORA = Date.UTC(2026, 10, 11, 1, 0, 0);   // 10/11 22:00 em Brasilia
d = await itensBry();
vale('as 22h a recepcao sai ("Boa noite") e o codigo espera o dia seguinte', !!de(d.itens, '98765432') && de(d.itens, '98765432').textos[0] === 'Boa noite Maria das Dores' && !(d.itens || []).some((x) => x.tipo === 'postado'), JSON.stringify((d.itens || []).map((x) => x.tipo[0])));
AGORA = Date.UTC(2026, 10, 10, 13, 0, 0);
const corpoC1 = { k: c1.k, chaves: c1.chaves, nk: NK_BRY, tipo: 'recepcao', fone: c1.fone, pedido: c1.pedido, nome: c1.nome };
r = await chama(TK.bry, '/api/swweb/auto/pega', corpoC1, 'mx');
vale('maquina sem o aluguel nao pega', r.d.ok === false, JSON.stringify(r.d));
r = await chama(TK.bry, '/api/swweb/auto/pega', corpoC1, 'mb');
vale('pega uma vez', r.d.ok === true, JSON.stringify(r.d));
r = await chama(TK.bry, '/api/swweb/auto/pega', corpoC1, 'mb');
vale('a segunda vez nao pega (ja foi)', r.d.ok === false && r.d.ja === true, JSON.stringify(r.d));
d = await itensBry();
vale('pego some da lista', !de(d.itens, '98765432'), '');
r = await chama(TK.bry, '/api/swweb/auto/feito', { k: c1.k, chaves: c1.chaves, nk: NK_BRY, ok: true, n: 3 }, 'mb');
vale('feito ok grava enviado', r.d.status === 'enviado' && linha(c1.k).status === 'enviado' && linha(c1.k).n === 3, JSON.stringify(linha(c1.k)));
// recepcao com codigo que o app pulou (o cobrador ja tinha respondido): o codigo fica livre
const corpoC2 = { k: c2.k, chaves: c2.chaves, nk: NK_BRY, tipo: 'recepcao', fone: c2.fone, pedido: c2.pedido, nome: c2.nome };
r = await chama(TK.bry, '/api/swweb/auto/pega', corpoC2, 'mb');
vale('a recepcao com codigo trava a chave do codigo junto', r.d.ok === true && linha('pos:1002:888031000000001') && linha('pos:1002:888031000000001').status === 'pego', JSON.stringify(linha('pos:1002:888031000000001')));
r = await chama(TK.bry, '/api/swweb/auto/feito', { k: c2.k, chaves: c2.chaves, nk: NK_BRY, ok: false, pulado: true, n: 0, motivo: 'já respondido na conversa' }, 'mb');
vale('pulada: a recepcao fica pulada e a chave do codigo e solta', r.d.status === 'pulado' && linha(c2.k).status === 'pulado' && !linha('pos:1002:888031000000001'), JSON.stringify(linha(c2.k)));
d = await itensBry();
const c2pos = (d.itens || []).find((x) => x.k === 'pos:1002:888031000000001');
vale('e o codigo daquele pedido passa a sair sozinho como Postado', !!c2pos && c2pos.tipo === 'postado' && !de((d.itens || []).filter((x) => x.tipo === 'recepcao'), '96665555'), JSON.stringify((d.itens || []).map((x) => x.k)));
// falhou sem sair: volta depois de 10 min, ate 3 vezes
const corpoAna = { k: ana.k, chaves: ana.chaves, nk: NK_BRY, tipo: 'recepcao', fone: ana.fone };
for (let i = 1; i <= 3; i++) {
  r = await chama(TK.bry, '/api/swweb/auto/pega', corpoAna, 'mb');
  const pegou = r.d.ok === true;
  r = await chama(TK.bry, '/api/swweb/auto/feito', { k: ana.k, nk: NK_BRY, ok: false, n: 0, motivo: 'pagina fora' }, 'mb');
  d = await itensBry();
  const logo = !!de(d.itens, '95554444');
  AGORA += 11 * 60000;
  d = await itensBry();
  const depois = !!de(d.itens, '95554444');
  if (i < 3) vale('falha ' + i + ' sem nada sair: some na hora e volta 10 min depois', pegou && !logo && depois, JSON.stringify({ pegou, logo, depois, st: linha(ana.k).status, tent: linha(ana.k).tent }));
  else vale('na terceira falha nao volta mais', pegou && !logo && !depois && linha(ana.k).tent === 3, JSON.stringify({ pegou, logo, depois, tent: linha(ana.k).tent }));
}
AGORA = Date.UTC(2026, 10, 10, 13, 0, 0);
const corpoPed = { k: ped.k, chaves: ped.chaves, nk: NK_BRY, tipo: 'recepcao', fone: ped.fone };
await chama(TK.bry, '/api/swweb/auto/pega', corpoPed, 'mb');
r = await chama(TK.bry, '/api/swweb/auto/feito', { k: ped.k, nk: NK_BRY, ok: false, n: 1, motivo: 'caiu no meio' }, 'mb');
AGORA += 30 * 60000;
d = await itensBry();
vale('parou no meio (um texto saiu): parcial, e nunca repete', r.d.status === 'parcial' && !de(d.itens, '94443333'), JSON.stringify(linha(ped.k)));
AGORA = Date.UTC(2026, 10, 10, 13, 0, 0);
// teto de 150 por numero em 24 h
const insT = sq.prepare("INSERT INTO swweb_auto (k, tipo, nk, status, pego_ts) VALUES (?, 'postado', ?, 'enviado', ?)");
for (let i = 0; i < 150; i++) insT.run('pos:teto' + i + ':AP000000' + i, NK_BRY, S() - 3600);
d = await itensBry();
vale('com 150 envios do numero em 24 h, para tudo dele', (d.itens || []).length === 0 && logs.some((l) => /COB_AUTO_TETO/.test(l)), String((d.itens || []).length));
sq.exec("DELETE FROM swweb_auto WHERE k LIKE 'pos:teto%'");

_log('\nA TELA DA DASH\n');
r = await chama(TK.dir, '/api/cob/auto');
vale('a direcao ve configuracao, padrao, o dia e a fila', r.st === 200 && r.d.cfg && r.d.padrao && r.d.hoje && Array.isArray(r.d.fila) && Array.isArray(r.d.ultimos), JSON.stringify(r.d.hoje));
vale('o dia conta a recepcao enviada e a pulada', r.d.hoje && r.d.hoje.recepcao === 1 && r.d.hoje.pulado >= 1, JSON.stringify(r.d.hoje));
vale('a fila mostra os dois numeros (sem aluguel) com o nome do cobrador', (r.d.fila || []).some((x) => x.nk === NK_HAY && x.cobrador === 'Haynan') && (r.d.fila || []).some((x) => x.nk === NK_BRY && x.cobrador === 'Bryan Amorim'), JSON.stringify((r.d.fila || []).map((x) => x.cobrador + ':' + x.tipo[0])));
r = await chama(TK.dir, '/api/cob/auto', { txt: { saudacao: 'Olá, {nome}! Tudo bem?', apresenta: estado && r.d.padrao.apresenta } });
const gravado = JSON.parse(sq.prepare("SELECT value FROM app_config WHERE key='cob_auto'").get().value);
vale('texto trocado grava; texto igual ao padrao nao grava (o padrao novo chega sozinho)', gravado.txt && gravado.txt.saudacao === 'Olá, {nome}! Tudo bem?' && !('apresenta' in gravado.txt) && gravado.rec === true, JSON.stringify(gravado.txt));
d = await itensBry();
vale('a saudacao nova vale com nome e sem nome', de(d.itens, '12340000') && de(d.itens, '12340000').textos[0] === 'Olá! Tudo bem?', de(d.itens, '12340000') && de(d.itens, '12340000').textos[0]);
r = await chama(TK.dir, '/api/cob/auto', { rec: false, pos: false });
d = await itensBry();
vale('desligou: o app nao recebe nada e pergunta de 5 em 5 min', (d.itens || []).length === 0 && d.proxima === 300 && r.d.cfg.rec === false, JSON.stringify(d));
r = await chama(TK.dir, '/api/cob/auto');
vale('desligado, a tela ainda mostra o que sairia (pra ver antes de ligar)', (r.d.fila || []).length > 0, String((r.d.fila || []).length));

_log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) { _log('FALHARAM:\n - ' + falhas.join('\n - ')); process.exit(1); }
