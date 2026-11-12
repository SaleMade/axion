// A VERSAO DE COBRADOR DO SELLWAVE WEB NA ROTA DE VERDADE (31/10/2026). Roda o worker inteiro (bundle
// do wrangler) contra um D1 de mentira e prova as duas metades do pedido:
//
//  1) NUMERO DE COBRADOR NAO E NUMERO DE VENDA. Um chip do Haynan marcado "Em uso" nunca recebe o
//     clique da pressel (/w/<id> nunca redireciona pra ele, nem quando o vendedor desliga o dele),
//     o interruptor recusa ligar, o aviso de fechamento do app nao grava nada no nome dele, e a lista
//     do app traz o numero como `cobranca`, sem roleta e fora do placar.
//  2) O QUE O APP DO COBRADOR LE: o cargo na lista de numeros (tambem no "ver como" da direcao), o
//     roteiro de COBRANCA, o pedido do cliente no painel, o quadro (/api/swweb/cobranca, com as
//     regras do Kanban da dash) e a ficha com os links. E que gravar pelo caminho de sempre
//     (/api/lead/:id) aparece no quadro na leitura seguinte.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-cobranca-rota.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-cobranca-rota.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER, versao TEXT)');
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
const exp = agoraS + 86400;
const usuarios = [['dir', 'Diretor', 'diretor'], ['kev', 'Kevin Marques', 'atendente'], ['hay', 'Haynan Souza', 'cobrador']];
for (const [id, nome, role] of usuarios) sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role);
const TK = { dir: 'd'.repeat(64), kev: 'b'.repeat(64), hay: 'c'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, exp);

// Brasilia "DD/MM HH:MM" de N dias atras (o formato do historico)
const brHist = (diasAtras) => {
  const d = new Date(Date.now() - diasAtras * 86400000 - 3 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
};
const brAgend = (diasDepois) => {
  const d = new Date(Date.now() + diasDepois * 86400000 - 3 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + 'T10:00';
};
const NUM_KEV = '(15) 99797-3450', NUM_HAY = '(11) 98888-7777';
const idMs = (dias) => String(Date.now() - dias * 86400000);
const L_COB = idMs(5), L_PAGO = idMs(9), L_ENV = idMs(2), L_AFL = idMs(4), L_MANUAL = idMs(1), L_VELHO = idMs(80), L_FRUST = idMs(6), L_RET = idMs(7);
const L_PAGO_VELHO_RET = idMs(40), L_PAGO_VELHO_SEM = idMs(41), L_PARC = idMs(8);
const L_P2 = idMs(10), L_P3 = idMs(11), L_P4 = idMs(12), L_P5 = idMs(13), L_P6 = idMs(14);
const estado = {
  wa_statuses: [{ id: 'st_uso', label: 'Em uso', papel: 'em_uso' }],
  chips: [
    { id: 'cK', num: NUM_KEV, at: 'kev', em_uso: true, wa_st: 'st_uso', idx: 2 },
    { id: 'cH', num: NUM_HAY, at: 'hay', em_uso: true, wa_st: 'st_uso', idx: 7 },
    { id: 'cH2', num: '(11) 97777-6666', at: 'hay', idx: 8 },
  ],
  pressels: [{ id: 1, nome: 'P1', status: 'ativa', vendedores: [] }],
  salechatPub: { messages: [{ id: 'mv', title: 'Fechar pedido', text: 'venda' }], sequences: [], media: [] },
  salechatCobPub: { messages: [{ id: 'mc', title: 'Rastreio', text: 'Seu pedido esta a caminho' }], sequences: [{ id: 'fc', title: 'Cobranca dia 1', steps: [] }], media: [] },
  checkout_plataformas: { pix: 'https://pix.exemplo.com/pagar?nome={nome}&valor={valor}&ped={pedido}' },
  tags: [{ id: 'vip', name: 'VIP', color: '#ff00aa' }],
  leads: [
    { id: L_COB, nome: 'Maria Cobranca', wa: '(31) 99876-5432', cidade: 'Belo Horizonte', uf: 'mg', trat: 'GlicoSix 3 Meses', vl: 297, col: 'Cobrança', spg: 'Pendente',
      at: 'kev', cob: 'hay', five_id: 'abc123', track: 'AB123456789BR', ship: 'DELIVERED', ship_ts: agoraS - 86400, agend: brAgend(-1), tags: ['vip'],
      hist: [{ from: 'A Enviar', to: 'Enviado', time: brHist(4) }, { from: 'Enviado', to: 'Entregue', time: brHist(1) }], comments: [{ who: 'kev', tx: 'oi', time: brHist(1) }] },
    { id: L_PAGO, nome: 'Joao Pago', wa: '11977776666', vl: 197, col: 'Pago', spg: 'Pago', pago_ts: Date.now() - 2 * 86400000, at: 'kev', cob: 'hay',
      hist: [{ from: 'Cobrança', to: 'Pagos', time: brHist(2) }] },
    { id: L_ENV, nome: 'Ana Enviada', wa: '21966665555', vl: 397, col: 'Enviado', at: 'kev', ship: 'IN_TRANSIT', hist: [{ from: 'A Enviar', to: 'Enviado', time: brHist(1) }] },
    { id: L_AFL, nome: 'Cliente do Afiliado', wa: '41955554444', vl: 297, col: 'Cobrança', at: 'kev', afl: 'afl_x' },
    { id: L_MANUAL, nome: 'Manual Nao Aceito', wa: '51944443333', vl: 297, col: 'A Enviar', orig: 'Manual', aceito: false, at: 'kev' },
    { id: L_VELHO, nome: 'Cancelado Antigo', wa: '61933332222', vl: 297, col: 'Cancelado', at: 'kev', hist: [{ from: 'A Enviar', to: 'Cancelado', time: '05/08/2026 10:00' }] },
    { id: L_FRUST, nome: 'Frustrado Recente', wa: '71922221111', vl: 297, col: 'Frustrado', at: 'kev', hist: [{ from: 'Saiu para Entrega', to: 'Frustrados', time: brHist(1) }] },
    { id: L_RET, nome: 'Retirada Sem Data', wa: '81911110000', vl: 497, col: 'Retirada', at: 'kev', cob: 'hay', hist: [{ from: 'Enviado', to: 'Retirada', time: brHist(1) }] },
    // PAGO HA 40 DIAS COM RETORNO MARCADO (05/11/2026): compromisso, nao historia. Entra apesar do
    // corte de 30 dias (o calendario do app precisa dele, como a dash); o mesmo pago SEM retorno nao.
    { id: L_PAGO_VELHO_RET, nome: 'Pago Antigo Com Retorno', wa: '91900001111', vl: 197, col: 'Pago', spg: 'Pago', pago_ts: Date.now() - 40 * 86400000, at: 'kev', cob: 'hay',
      agend: brAgend(2), hist: [{ from: 'Cobrança', to: 'Pagos', time: brHist(40) }] },
    { id: L_PAGO_VELHO_SEM, nome: 'Pago Antigo Sem Retorno', wa: '91900002222', vl: 197, col: 'Pago', spg: 'Pago', pago_ts: Date.now() - 40 * 86400000, at: 'kev', cob: 'hay',
      hist: [{ from: 'Cobrança', to: 'Pagos', time: brHist(40) }] },
    // NA COBRANCA, VAI PAGAR EM PARTES (05/11/2026, o pagamento parcial da ficha do app).
    { id: L_PARC, nome: 'Paula Parcial', wa: '31977770000', vl: 497, col: 'Cobrança', spg: 'Pendente', at: 'kev', cob: 'hay', agend: brAgend(1),
      hist: [{ from: 'Enviado', to: 'Entregue', time: brHist(2) }] },
    // OS CAMINHOS QUE FECHAM O PEDIDO POR FORA DO APP (05/11/2026, revisao): a ficha de parcelas tem
    // que fechar junto, senao a receita e a comissao saem pelo valor da parcela.
    { id: L_P2, nome: 'Pedro Kanban', wa: '31977770002', vl: 497, col: 'Cobrança', spg: 'Pendente', at: 'kev', cob: 'hay', hist: [{ from: 'Enviado', to: 'Entregue', time: brHist(2) }] },
    { id: L_P3, nome: 'Pati Duas Parcelas', wa: '31977770003', vl: 297, col: 'Cobrança', spg: 'Pendente', at: 'kev', cob: 'hay', agend: brAgend(3), hist: [{ from: 'Enviado', to: 'Entregue', time: brHist(2) }] },
    { id: L_P4, nome: 'Pablo Lista Velha', wa: '31977770004', vl: 297, col: 'Cobrança', spg: 'Pendente', at: 'kev', cob: 'hay', hist: [{ from: 'Enviado', to: 'Entregue', time: brHist(2) }] },
    { id: L_P5, nome: 'Paulo Arrasto Desconto', wa: '31977770005', vl: 297, valor_neg: 250, col: 'Cobrança', spg: 'Pendente', at: 'kev', cob: 'hay', hist: [{ from: 'Enviado', to: 'Entregue', time: brHist(2) }] },
    { id: L_P6, nome: 'Pietra Encerrar', wa: '31977770006', vl: 397, col: 'Cobrança', spg: 'Pendente', at: 'kev', cob: 'hay', hist: [{ from: 'Enviado', to: 'Entregue', time: brHist(2) }] },
  ],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-cobranca.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const chama = async (tk, path, body, maquina) => {
  const h = {};
  if (tk) h.authorization = 'Bearer ' + tk;
  if (body) h['content-type'] = 'application/json';
  if (maquina) { h['x-sw-maquina'] = maquina; h['x-sw-versao'] = '1.26.0'; }
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env, ctx);
  let d = {};
  try { d = await r.clone().json(); } catch (_) { d = {}; }
  return { st: r.status, d, loc: r.headers.get('location') || '', txt: d && Object.keys(d).length ? '' : await r.text().catch(() => '') };
};
const ler = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data);
const temEntradaDoHaynan = () => (ler().pressels || []).some((p) => (p.vendedores || []).some((v) => v && v.at === 'hay'));

_log('\nNUMERO DE COBRADOR FORA DA ROLETA\n');

// 1) a lista que o app le
let r = await chama(TK.hay, '/api/swweb/numeros', null, 'mh');
vale('o app do cobrador recebe o cargo', r.st === 200 && r.d.cargo === 'cobrador', r.st + ' ' + r.d.cargo);
const nH = (r.d.numeros || []).find((n) => String(n.numero).replace(/\D/g, '').endsWith('88887777'));
vale('o numero dele vem marcado como de cobranca e sem roleta', !!nH && nH.cobranca === true && nH.roleta === false, JSON.stringify(nH && { cobranca: nH.cobranca, roleta: nH.roleta }));
vale('o cobrador nao recebe o placar de leads da equipe', Array.isArray(r.d.equipe) && r.d.equipe.length === 0, JSON.stringify(r.d.equipe));
r = await chama(TK.dir, '/api/swweb/numeros', null, 'md');
vale('a direcao recebe a lista de cobradores pro "ver como"', (r.d.cobradores || []).some((c) => c.id === 'hay' && /Haynan/.test(c.nome)), JSON.stringify(r.d.cobradores));
vale('no placar da direcao o cobrador nao aparece', !(r.d.equipe || []).some((e) => e.at === 'hay'), JSON.stringify((r.d.equipe || []).map((e) => e.at)));
vale('o numero do vendedor continua sendo de venda', (r.d.numeros || []).some((n) => n.at === 'kev' && n.cobranca === false), '');
r = await chama(TK.dir, '/api/swweb/numeros?como=hay', null, 'md');
vale('o "ver como" da direcao vira cobrador', r.st === 200 && r.d.cargo === 'cobrador', r.d.cargo);

// 2) a roleta: /w/1 nunca manda pro numero do cobrador
const destinos = [];
for (let i = 0; i < 6; i++) { r = await chama('', '/w/1'); destinos.push((r.loc.match(/(\d{8,13})/) || [])[1] || ('st' + r.st)); }
vale('seis cliques na pressel: nenhum vai pro numero do cobrador', destinos.every((x) => !String(x).endsWith('88887777')), destinos.join(' '));
vale('e eles vao pro vendedor', destinos.some((x) => String(x).endsWith('97973450')), destinos.join(' '));
r = await chama(TK.dir, '/api/pressel/num', { at: 'kev', num: NUM_KEV, on: false });
vale('a direcao desliga o numero do Kevin', r.st === 200, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
const depois = [];
for (let i = 0; i < 3; i++) { r = await chama('', '/w/1'); depois.push((r.loc.match(/(\d{8,13})/) || [])[1] || ('st' + r.st)); }
vale('com o vendedor desligado, a pressel continua sem mandar pro cobrador', depois.every((x) => !String(x).endsWith('88887777')), depois.join(' '));

// 3) o interruptor
r = await chama(TK.dir, '/api/pressel/num', { at: 'hay', num: NUM_HAY, on: true });
vale('a direcao NAO liga o numero do cobrador (409)', r.st === 409 && /cobran/i.test(String(r.d.error || '')), r.st + ' ' + r.d.error);
r = await chama(TK.hay, '/api/pressel/meu-numero', { num: NUM_HAY, on: true });
vale('o cobrador tambem nao liga pela tela dele (409)', r.st === 409 && /cobran/i.test(String(r.d.error || '')), r.st + ' ' + r.d.error);
r = await chama(TK.hay, '/api/swweb/fechando', { por: 'fechou o app' }, 'mh');
vale('fechar o app do cobrador nao desliga nada (ele nao tem interruptor)', r.st === 200 && r.d.desligou === 0, JSON.stringify(r.d));
vale('e nada foi gravado no nome dele nas pressels', !temEntradaDoHaynan(), JSON.stringify(ler().pressels[0].vendedores));

_log('\nO QUE O APP DO COBRADOR LE\n');

// 4) o roteiro
r = await chama(TK.hay, '/api/swweb/roteiro');
vale('o cobrador recebe o roteiro de COBRANCA', r.st === 200 && r.d.perfil === 'cob' && (r.d.messages || [])[0] && r.d.messages[0].id === 'mc' && (r.d.sequences || []).length === 1, JSON.stringify({ perfil: r.d.perfil, m: (r.d.messages || []).map((m) => m.id) }));
r = await chama(TK.kev, '/api/swweb/roteiro');
vale('o vendedor continua com o de venda', r.st === 200 && r.d.perfil === 'vend' && r.d.messages[0].id === 'mv', JSON.stringify({ perfil: r.d.perfil }));

// 5) o pedido do cliente no painel
r = await chama(TK.hay, '/api/swweb/lead?phone=5531998765432');
vale('o painel do cobrador acha o pedido do cliente (antes dava "sem pedido")', r.st === 200 && r.d.achou === true && r.d.id === L_COB, JSON.stringify(r.d).slice(0, 120));
r = await chama(TK.kev, '/api/swweb/lead?phone=5531998765432');
vale('o vendedor continua vendo o pedido dele', r.d.achou === true, '');

// 6) o quadro
r = await chama(TK.kev, '/api/swweb/cobranca');
vale('vendedor nao le o quadro de cobranca (403)', r.st === 403, r.st);
r = await chama(TK.hay, '/api/swweb/cobranca');
const ids = (r.d.pedidos || []).map((p) => p.id);
vale('o quadro responde', r.st === 200 && Array.isArray(r.d.pedidos) && !!r.d.sig, r.st);
vale('traz a fila, o pago recente, o enviado, o frustrado recente, a retirada e o pago antigo COM retorno marcado', [L_COB, L_PAGO, L_ENV, L_FRUST, L_RET, L_PAGO_VELHO_RET].every((x) => ids.includes(x)), JSON.stringify(ids));
vale('nao traz pedido do afiliado, card manual nao aceito, cancelado de 80 dias nem pago antigo sem retorno', ![L_AFL, L_MANUAL, L_VELHO, L_PAGO_VELHO_SEM].some((x) => ids.includes(x)), '');
const pC = (r.d.pedidos || []).find((p) => p.id === L_COB) || {};
vale('a coluna sai pelo apelido da dash (Cobranca -> Entregues)', pC.col === 'Entregues' && pC.colBruta === 'Cobrança', pC.col);
vale('valor, vendedor, cobrador e telefone em digitos', pC.valor === 297 && pC.atNome === 'Kevin Marques' && pC.cobNome === 'Haynan Souza' && pC.wa === '31998765432', JSON.stringify({ v: pC.valor, at: pC.atNome, cob: pC.cobNome, wa: pC.wa }));
vale('selo de entrega e "Entregue em ... · N dias"', pC.selo && pC.selo.label === 'Entregue' && pC.entrega && pC.entrega.label === 'Entregue em' && /dias?$/.test(pC.entrega.dias), JSON.stringify({ selo: pC.selo, entrega: pC.entrega }));
vale('a tag vem com nome e cor, e o retorno vem cru', pC.tags && pC.tags[0] && pC.tags[0].nome === 'VIP' && pC.agend === estado.leads[0].agend, JSON.stringify(pC.tags));
vale('transportadora pelo codigo dos Correios', pC.transp === 'Correios', pC.transp);
const pP = (r.d.pedidos || []).find((p) => p.id === L_PAGO) || {};
vale('o pago vem pago, na coluna Pagos, com a data do pagamento', pP.pago === true && pP.col === 'Pagos' && pP.pagoTs > 0 && pP.vc === true, JSON.stringify({ pago: pP.pago, col: pP.col }));
const pF = (r.d.pedidos || []).find((p) => p.id === L_FRUST) || {};
vale('frustrado nao leva selo de entrega (a coluna manda)', pF.col === 'Frustrados' && !pF.selo, JSON.stringify(pF.selo));
vale('os comentarios prontos padrao e as colunas vem junto', (r.d.prontos || []).length === 6 && (r.d.cols || []).length === 8 && (r.d.perda || []).length === 5, '');
const sig = r.d.sig;
r = await chama(TK.hay, '/api/swweb/cobranca?sig=' + encodeURIComponent(sig));
vale('sem mudanca, a releitura volta vazia (igual)', r.st === 200 && r.d.igual === true && !r.d.pedidos, JSON.stringify(r.d).slice(0, 80));

// 7) a ficha
r = await chama(TK.hay, '/api/swweb/cobranca/pedido?phone=5531998765432');
const f = (r.d.pedidos || [])[0] || {};
vale('a ficha pelo telefone acha o pedido', r.st === 200 && f.id === L_COB, r.st + ' ' + f.id);
vale('link de checkout da Five pelo pedido', /fivedelivery\.com\.br\/checkout\/011\/abc123$/.test(String(f.links && f.links.checkout)), f.links && f.links.checkout);
vale('Pix da plataforma com os dados trocados', String(f.links && f.links.pix) === 'https://pix.exemplo.com/pagar?nome=Maria%20Cobranca&valor=297.00&ped=' + L_COB, f.links && f.links.pix);
vale('rastreio dos Correios (pedido da Five com codigo AB...BR)', /rastreamento\.correios\.com\.br\/app\/index\.php\?objetos=AB123456789BR/.test(String(f.links && f.links.rastreio)), f.links && f.links.rastreio);
vale('historico recente com o nome de quem mexeu', Array.isArray(f.hist) && f.hist.length === 2, JSON.stringify(f.hist).slice(0, 80));
vale('comentarios com o NOME de quem escreveu, e os prontos junto (o painel so le esta rota)', Array.isArray(f.comentarios) && f.comentarios[0] && f.comentarios[0].quem === 'Kevin Marques' && f.comentarios[0].tx === 'oi' && Array.isArray(r.d.prontos) && r.d.prontos.length === 6, JSON.stringify({ c: f.comentarios, p: (r.d.prontos || []).length }));
r = await chama(TK.hay, '/api/swweb/cobranca/pedido?phone=5541955554444');
vale('pedido do afiliado nao abre na ficha da casa', r.st === 200 && (r.d.pedidos || []).length === 0, JSON.stringify(r.d).slice(0, 60));

// 8) gravar pelo caminho de sempre e o quadro acompanhar
const amanha = brAgend(1);
r = await chama(TK.hay, '/api/lead/' + L_RET, { patch: { agend: amanha } });
vale('o cobrador marca o retorno pela rota de sempre', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
r = await chama(TK.hay, '/api/lead/' + L_COB, { patch: { spg: 'Pago', valor_neg: 280, col: 'Pagos', antes: { spg: 'Pendente', col: 'Cobrança' } } });
vale('e marca pago com o valor, numa chamada so', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
r = await chama(TK.hay, '/api/swweb/cobranca?sig=' + encodeURIComponent(sig));
const pR = (r.d.pedidos || []).find((p) => p.id === L_RET) || {};
const pC2 = (r.d.pedidos || []).find((p) => p.id === L_COB) || {};
vale('a releitura muda a assinatura e traz o retorno novo', r.d.igual !== true && pR.agend === amanha, JSON.stringify({ igual: r.d.igual, agend: pR.agend }));
vale('e o pedido pago foi pra Pagos com o valor recebido', pC2.col === 'Pagos' && pC2.pago === true && pC2.valor === 280 && !pC2.agend, JSON.stringify({ col: pC2.col, valor: pC2.valor, agend: pC2.agend }));
// o comentario do app vai SEM `who`: quem fica e quem esta logado (aqui, o proprio cobrador)
r = await chama(TK.hay, '/api/lead/' + L_RET, { patch: { comment_add: { tx: 'prometeu pagar sexta' } } });
const fc = await chama(TK.hay, '/api/swweb/cobranca/pedido?id=' + L_RET);
const c0 = ((fc.d.pedidos || [])[0] || {}).comentarios || [];
vale('comentario sem "who" fica no nome de quem esta logado', r.st === 200 && c0[0] && c0[0].tx === 'prometeu pagar sexta' && c0[0].quem === 'Haynan Souza', JSON.stringify(c0[0]));

_log('\nPAGAMENTO PARCIAL PELA FICHA DO APP (05/11/2026)\n');

// 8b) pagamento_add ACRESCENTA uma parcela: o pedido fica na fila com o saldo; quitar fecha com o total
r = await chama(TK.kev, '/api/lead/' + L_PARC, { patch: { pagamento_add: { valor: 100 } } });
let fd = await chama(TK.hay, '/api/swweb/cobranca/pedido?id=' + L_PARC);
let pd = (fd.d.pedidos || [])[0] || {};
vale('vendedor nao registra parcela (negado, e a ficha segue sem parcela)', r.st === 200 && (r.d.negados || []).includes('pagamento_add') && (pd.pagamentos || []).length === 0, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
r = await chama(TK.hay, '/api/lead/' + L_PARC, { patch: { pagamento_add: { valor: 100, obs: 'parcial pelo SellWave Web' }, antes: { spg: 'Pendente', col: 'Cobrança' } } });
vale('o cobrador registra a parcela pela rota de sempre, com o "antes", e a resposta prova quantas parcelas ficaram', r.st === 200 && r.d.ok && !(r.d.negados || []).length && r.d.parcelas === 1, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
fd = await chama(TK.hay, '/api/swweb/cobranca/pedido?id=' + L_PARC);
pd = (fd.d.pedidos || [])[0] || {};
vale('a ficha traz a parcela com o nome de quem registrou e a data de hoje; o saldo cai (497 - 100), nao e pago, vira Parcial e fica na fila com o retorno',
  Array.isArray(pd.pagamentos) && pd.pagamentos.length === 1 && pd.pagamentos[0].valor === 100 && pd.pagamentos[0].quem === 'Haynan Souza' && /^\d\d\/\d\d\/\d{4}$/.test(pd.pagamentos[0].data)
  && pd.saldo === 397 && pd.pago === false && pd.spg === 'Parcial' && pd.col === 'Entregues' && pd.agend === amanha, JSON.stringify({ p: pd.pagamentos, saldo: pd.saldo, pago: pd.pago, spg: pd.spg, col: pd.col, agend: pd.agend }));
r = await chama(TK.hay, '/api/lead/' + L_PARC, { patch: { pagamento_add: { valor: 0 } } });
fd = await chama(TK.hay, '/api/swweb/cobranca/pedido?id=' + L_PARC);
vale('parcela zerada nao entra', r.st === 200 && (((fd.d.pedidos || [])[0] || {}).pagamentos || []).length === 1, JSON.stringify(((fd.d.pedidos || [])[0] || {}).pagamentos));
r = await chama(TK.hay, '/api/lead/' + L_PARC, { patch: { pagamento_add: { valor: 397, obs: 'quitou pelo SellWave Web' }, spg: 'Pago', valor_neg: 497, col: 'Pagos', antes: { spg: 'Pendente', col: 'Cobrança' } } });
vale('o "antes" velho (a ficha nao recarregou depois da parcela) e recusado com 409', r.st === 409 && r.d.mudou === true && r.d.spg === 'Parcial', r.st + ' ' + JSON.stringify(r.d).slice(0, 100));
r = await chama(TK.hay, '/api/lead/' + L_PARC, { patch: { pagamento_add: { valor: 397, obs: 'quitou pelo SellWave Web' }, spg: 'Pago', valor_neg: 497, col: 'Pagos', antes: { spg: 'Parcial', col: 'Cobrança' } } });
vale('o resto entra como parcela junto com o pago e a coluna, numa chamada so', r.st === 200 && r.d.ok && !(r.d.negados || []).length, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
fd = await chama(TK.hay, '/api/swweb/cobranca/pedido?id=' + L_PARC);
pd = (fd.d.pedidos || [])[0] || {};
vale('pago, em Pagos, duas parcelas somando 497, saldo zero e sem retorno (pago limpa a agenda)',
  pd.pago === true && pd.col === 'Pagos' && pd.spg === 'Pago' && pd.valor === 497 && pd.saldo === 0 && (pd.pagamentos || []).length === 2 && pd.pagamentos.reduce((s, x) => s + x.valor, 0) === 497 && !pd.agend, JSON.stringify({ pago: pd.pago, col: pd.col, valor: pd.valor, saldo: pd.saldo, n: (pd.pagamentos || []).length, agend: pd.agend }));

// 8c) A FICHA FECHA JUNTO COM O PAGO, por qualquer caminho (revisao de 05/11/2026)
const ficha = async (id) => (((await chama(TK.hay, '/api/swweb/cobranca/pedido?id=' + id)).d.pedidos || [])[0] || {});
const soma = (p) => (p.pagamentos || []).reduce((s, x) => s + x.valor, 0);
// (a) parcela pelo app + "Ja pagou" do Kanban da dash (spg, valor_neg e col, sem parcela)
r = await chama(TK.hay, '/api/lead/' + L_P2, { patch: { pagamento_add: { valor: 100 } } });
r = await chama(TK.dir, '/api/lead/' + L_P2, { patch: { spg: 'Pago', valor_neg: 497, col: 'Pagos' } });
pd = await ficha(L_P2);
vale('parcela de 100 + "Ja pagou" do Kanban: entra a parcela do resto (397) em nome de quem marcou, soma 497, saldo zero',
  r.st === 200 && pd.pago === true && pd.col === 'Pagos' && (pd.pagamentos || []).length === 2 && soma(pd) === 497 && pd.pagamentos[1].valor === 397 && pd.pagamentos[1].quem === 'Diretor' && pd.saldo === 0, JSON.stringify({ p: pd.pagamentos, saldo: pd.saldo }));
// (b) duas parcelas que juntas cobrem o valor: o pedido fecha (Pago, Pagos, data do pagamento, retorno limpo)
r = await chama(TK.hay, '/api/lead/' + L_P3, { patch: { pagamento_add: { valor: 50 } } });
r = await chama(TK.hay, '/api/lead/' + L_P3, { patch: { pagamento_add: { valor: 247 } } });
pd = await ficha(L_P3);
vale('duas parcelas que cobrem o valor (50 + 247 = 297) fecham o pedido: Pago, em Pagos, com data, sem retorno, sem parcela a mais',
  r.st === 200 && pd.pago === true && pd.spg === 'Pago' && pd.col === 'Pagos' && pd.pagoTs > 0 && !pd.agend && (pd.pagamentos || []).length === 2 && soma(pd) === 297 && pd.saldo === 0, JSON.stringify({ spg: pd.spg, col: pd.col, pagoTs: pd.pagoTs, agend: pd.agend, p: pd.pagamentos }));
// (c) a lista inteira vinda de uma copia velha (o /app do celular) SOMA, nao apaga a parcela do app
r = await chama(TK.hay, '/api/lead/' + L_P4, { patch: { pagamento_add: { valor: 100 } } });
r = await chama(TK.dir, '/api/lead/' + L_P4, { patch: { pagamentos: [{ ts: agoraS - 30, data: '05/11/2026', valor: 50, obs: 'registrado no aplicativo' }] } });
pd = await ficha(L_P4);
vale('lista inteira sem a parcela do app (copia velha): a parcela fica, a nova entra, saldo 147 e Parcial',
  r.st === 200 && (pd.pagamentos || []).length === 2 && soma(pd) === 150 && pd.saldo === 147 && pd.spg === 'Parcial' && pd.pago === false, JSON.stringify({ p: pd.pagamentos, saldo: pd.saldo, spg: pd.spg }));
r = await chama(TK.dir, '/api/lead/' + L_P4, { patch: { pagamentos: [{ ts: agoraS - 30, data: '05/11/2026', valor: 50, obs: 'registrado no aplicativo' }] } });
pd = await ficha(L_P4);
vale('a mesma lista de novo nao duplica nada', (pd.pagamentos || []).length === 2 && soma(pd) === 150, JSON.stringify(pd.pagamentos));
// (d) parcela + arrasto pra Pagos num pedido com desconto gravado (valor_neg 250): o resto e 150, nao 197
r = await chama(TK.hay, '/api/lead/' + L_P5, { patch: { pagamento_add: { valor: 100 } } });
r = await chama(TK.dir, '/api/lead/' + L_P5 + '/move', { col: 'Pagos' });
pd = await ficha(L_P5);
vale('parcela de 100 + arrasto pra Pagos com desconto de 250: o resto e 150 (valor negociado), soma 250, pago',
  r.st === 200 && pd.pago === true && pd.valor === 250 && (pd.pagamentos || []).length === 2 && pd.pagamentos[1].valor === 150 && soma(pd) === 250 && pd.saldo === 0, JSON.stringify({ st: r.st, valor: pd.valor, p: pd.pagamentos, saldo: pd.saldo }));
// (e) lista inteira junto com o Pago (o "encerrar com desconto" do /app): a ficha dele e a verdade, nada e acrescentado
r = await chama(TK.dir, '/api/lead/' + L_P6, { patch: { pagamentos: [{ ts: agoraS - 10, data: '05/11/2026', valor: 300, obs: 'encerrado com desconto no aplicativo' }], spg: 'Pago' } });
pd = await ficha(L_P6);
vale('lista inteira + Pago (encerrar com desconto): fica so a parcela de 300 num pedido de 397, pago, sem parcela do resto',
  r.st === 200 && pd.pago === true && (pd.pagamentos || []).length === 1 && soma(pd) === 300, JSON.stringify({ p: pd.pagamentos, pago: pd.pago, saldo: pd.saldo }));

_log('\nEM QUAL NUMERO DO COBRADOR O CLIENTE JA FALOU (03/11/2026)\n');

// 9) /api/swweb/cobranca/contato: so mensagem DO CLIENTE, so numero DELE, o mais recente primeiro
try { sq.exec('ALTER TABLE wa_messages ADD COLUMN mundo TEXT'); } catch (_) {}
const msg = (id, phone, inst, dir, ts, mundo) => sq.prepare('INSERT INTO wa_messages (msg_id,phone,instance,direction,type,body,ts,mundo) VALUES (?,?,?,?,?,?,?,?)').run(id, phone, inst, dir, 'text', 'x', ts, mundo || null);
msg('m1', '5531998765432', 'ax_hay_88887777', 'in', agoraS - 3600);           // a cliente escreveu no numero 1 do cobrador
msg('m2', '5531998765432', 'ax_hay_88887777', 'out', agoraS - 10);            // resposta do cobrador: nao conta como contato
msg('m3', '553198765432', 'ax_ccol_1_77776666', 'in', agoraS - 600);          // numero 2, sem o nono digito e com o dono antigo
msg('m4', '5531998765432', 'ax_kev_97973450', 'in', agoraS - 5);              // numero do VENDEDOR: nunca sai pro cobrador
msg('m5', '5531998765432', 'ax_hay_88887777', 'in', agoraS - 1, 'afl_x');     // outro mundo
msg('m6', '5521966665555', 'ax_hay_77776666', 'out', agoraS - 100);           // o cobrador chamou e o cliente nunca respondeu
r = await chama(TK.hay, '/api/swweb/cobranca/contato?phone=31998765432');
const nums = (r.d.numeros || []).map((x) => x.n8 + '@' + (agoraS - x.ts));
vale('acha os dois numeros dele em que a cliente escreveu, o mais recente primeiro', r.st === 200 && nums.join(',') === '77776666@600,88887777@3600', r.st + ' ' + nums.join(','));
vale('o numero do vendedor e a mensagem de outro mundo nao aparecem', !(r.d.numeros || []).some((x) => x.n8 === '97973450') && !nums.some((x) => /@1$/.test(x)), nums.join(','));
r = await chama(TK.hay, '/api/swweb/cobranca/contato?phone=5521966665555');
vale('conversa que so o cobrador mandou nao conta (o cliente nunca entrou em contato)', r.st === 200 && (r.d.numeros || []).length === 0, JSON.stringify(r.d));
r = await chama(TK.hay, '/api/swweb/cobranca/contato?phone=11900001111');
vale('cliente que nunca falou: lista vazia', r.st === 200 && (r.d.numeros || []).length === 0, JSON.stringify(r.d));
r = await chama(TK.dir, '/api/swweb/cobranca/contato?phone=5531998765432&como=hay');
vale('o "ver como" da direcao ve o mesmo que o cobrador', r.st === 200 && (r.d.numeros || []).length === 2 && r.d.numeros[0].n8 === '77776666', JSON.stringify(r.d));
r = await chama(TK.kev, '/api/swweb/cobranca/contato?phone=5531998765432');
vale('vendedor nao le (403)', r.st === 403, r.st);

_log('\nA COLUNA "ENTRARAM EM CONTATO" (03/11/2026)\n');

// 10) o cliente escreveu e ninguem respondeu: o pedido vem com `contato`; respondeu ou mexeu, sai
const doQuadro = async (id) => { const q = await chama(TK.hay, '/api/swweb/cobranca'); return ((q.d.pedidos || []).find((p) => p.id === id)) || {}; };
msg('m7', '5521966665555', 'ax_hay_77776666', 'in', agoraS - 50);              // a Ana respondeu depois do cobrador (m6 foi -100)
let pE = await doQuadro(L_ENV);
vale('cliente que escreveu depois da ultima resposta vem marcado', pE.contato === (agoraS - 50) * 1000, String(pE.contato));
vale('quem o cobrador ja respondeu nao vem marcado', !(await doQuadro(L_COB)).contato, '');
r = await chama(TK.hay, '/api/lead/' + L_ENV, { patch: { agend: brAgend(2) } });
pE = await doQuadro(L_ENV);
vale('o cobrador marcou retorno: o card sai da coluna', r.st === 200 && !pE.contato, JSON.stringify({ st: r.st, contato: pE.contato }));
const depoisS = Math.floor(Date.now() / 1000) + 5;
msg('m8', '5521966665555', 'ax_hay_77776666', 'in', depoisS);
pE = await doQuadro(L_ENV);
vale('o cliente escreveu de novo: volta', pE.contato === depoisS * 1000, String(pE.contato));
msg('m9', '5521966665555', 'ax_hay_88887777', 'out', depoisS + 3);           // respondeu pelo OUTRO numero dele
pE = await doQuadro(L_ENV);
vale('respondeu (por qualquer numero dele): sai', !pE.contato, String(pE.contato));
r = await chama(TK.hay, '/api/lead/' + L_ENV, { patch: { obs: 'so o endereco' } });
msg('m10', '5521966665555', 'ax_hay_77776666', 'in', depoisS + 9);
pE = await doQuadro(L_ENV);
vale('corrigir um campo que nao e de cobranca nao tira o card (nao e mexer na cobranca)', pE.contato === (depoisS + 9) * 1000, String(pE.contato));
r = await chama(TK.dir, '/api/swweb/cobranca?como=hay');
vale('o "ver como" da direcao ve a mesma coluna', ((r.d.pedidos || []).find((p) => p.id === L_ENV) || {}).contato === (depoisS + 9) * 1000, '');
r = await chama(TK.dir, '/api/swweb/cobranca');
vale('a direcao sem "ver como" nao tem numero de cobranca, entao ninguem vem marcado', !(r.d.pedidos || []).some((p) => p.contato), '');

_log('\nAS TAGS NO APP (03/11/2026)\n');
r = await chama(TK.hay, '/api/swweb/cobranca');
vale('o quadro manda o catalogo de tags com id, nome e cor', (r.d.tags || []).length === 1 && r.d.tags[0].id === 'vip' && r.d.tags[0].nome === 'VIP', JSON.stringify(r.d.tags));
vale('e a tag do pedido vem com o id (a ficha sabe qual esta marcada)', ((r.d.pedidos || []).find((p) => p.id === L_COB) || {}).tags?.[0]?.id === 'vip', '');
r = await chama(TK.hay, '/api/lead/' + L_ENV, { patch: { tags: ['vip', 'inventada'] } });
pE = await doQuadro(L_ENV);
vale('o cobrador marca tag pelo caminho de sempre (e id que nao existe e jogado fora)', r.st === 200 && (pE.tags || []).map((t) => t.id).join(',') === 'vip', JSON.stringify(pE.tags));

_log('\nO COBRADOR SO LEVA PRA PAGOS OU PRA PERDA (03/11/2026)\n');
const colDe = (id) => (ler().leads.find((l) => String(l.id) === id) || {}).col;
r = await chama(TK.hay, '/api/lead/' + L_RET, { patch: { col: 'Enviados' } });
vale('cobrador nao leva Retirada pra Enviado (vem recusado e nao grava)', (r.d.negados || []).includes('col') && colDe(L_RET) === 'Retirada', JSON.stringify({ neg: r.d.negados, col: colDe(L_RET) }));
r = await chama(TK.hay, '/api/lead/' + L_ENV, { patch: { col: 'Saiu para Entrega' } });
vale('nem Enviado pra Saiu para Entrega', (r.d.negados || []).includes('col') && colDe(L_ENV) === 'Enviado', JSON.stringify({ neg: r.d.negados, col: colDe(L_ENV) }));
r = await chama(TK.hay, '/api/lead/' + L_RET, { patch: { col: 'Retirar nos Correios', obs: 'x' } });
vale('a mesma coluna com outro nome nao conta como mudanca', !(r.d.negados || []).includes('col'), JSON.stringify(r.d.negados));
r = await chama(TK.hay, '/api/lead/' + L_RET, { patch: { col: 'Frustrados' } });
vale('pra perda ele leva', r.st === 200 && !(r.d.negados || []).length && colDe(L_RET) === 'Frustrados', JSON.stringify({ neg: r.d.negados, col: colDe(L_RET) }));
// REQUER ATENCAO VIROU DESTINO DO COBRADOR (12/11/2026, pedido do Bruno: o Bryan nao conseguia tirar da
// fila o pedido em que o lead nao responde). Mas de Pagos continua so pra perda.
r = await chama(TK.hay, '/api/lead/' + L_ENV, { patch: { col: 'Requer Atenção' } });
vale('cobrador leva pra Requer Atenção', r.st === 200 && !(r.d.negados || []).includes('col') && colDe(L_ENV) === 'Requer Atenção', JSON.stringify({ neg: r.d.negados, col: colDe(L_ENV) }));
r = await chama(TK.hay, '/api/lead/' + L_PAGO_VELHO_SEM, { patch: { col: 'Requer Atenção' } });
vale('mas nao tira de Pagos pra Requer Atenção (de Pagos so pra perda)', (r.d.negados || []).includes('col') && colDe(L_PAGO_VELHO_SEM) === 'Pago', JSON.stringify({ neg: r.d.negados, col: colDe(L_PAGO_VELHO_SEM) }));
r = await chama(TK.dir, '/api/lead/' + L_ENV, { patch: { col: 'Saiu para Entrega' } });
vale('a direcao continua movendo pra qualquer etapa', r.st === 200 && colDe(L_ENV) === 'Saiu para Entrega', colDe(L_ENV));

_log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram.');
if (falhas.length) { _log('\nFALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
process.exit(0);
