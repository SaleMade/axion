// A CENTRAL DE CELULARES NO APP (10/11/2026), NA ROTA DE VERDADE. Roda o worker inteiro (bundle do
// wrangler) contra um D1 de mentira e prova:
//   1) o agente do PC so entra com o token dele; o app so com sessao da direcao DA CASA;
//   2) o retrato que o agente manda chega podado na tela (nada alem do que ela usa, senha nunca);
//   3) so passa pedido da lista (nada de /api/proteger, nem caminho torto);
//   4) o pedido vai do app ao agente e a resposta volta pro app; ninguem leva o mesmo pedido duas vezes;
//   5) PEDIDO VELHO NAO RODA: nao pego a tempo expira e o agente nunca recebe;
//   6) PC desligado = o app sabe na hora, sem enfileirar nada;
//   7) a proxy colada (com a senha) sai do banco assim que o pedido termina;
//   8) tarefa disparada pelo app avisa quem pediu quando termina, uma vez so, e nao avisa quem esta olhando;
//   9) "celular com outra proxy" pela mesma regra da gaveta da Contingencia.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-central-remota.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-central-remota.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
try { sq.exec('ALTER TABLE users ADD COLUMN afiliado_id TEXT'); } catch (_) { /* ja tem */ }
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
const logs = [];
console.log = (...a) => { logs.push(a.join(' ')); };

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

const agoraS = () => Math.floor(Date.now() / 1000);
const exp = agoraS() + 86400;
const usuarios = [
  ['dir', 'Bruno Diretor', 'diretor', null],
  ['soc', 'Heynan Socio', 'socio', null],
  ['kev', 'Kevin Marques', 'atendente', null],
  ['hay', 'Haynan Cobrador', 'cobrador', null],
  ['gio', 'Giovane Afiliado', 'afiliado', 'afl_1'],
];
for (const [id, nome, role, afl] of usuarios) {
  sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role, afl);
}
const TK = {};
usuarios.forEach(([id], i) => { TK[id] = String.fromCharCode(97 + i).repeat(64); sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[id], id, exp); });
sq.prepare('INSERT INTO dashboard_state (id, data, version, updated_at) VALUES (1, ?, 1, ?)').run(JSON.stringify({}), agoraS());
const cfg = (k) => { const r = sq.prepare('SELECT value FROM app_config WHERE key = ?').get(k); return r ? r.value : null; };
const poeCfg = (k, v) => sq.prepare("INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-central.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const chama = async (auth, path, body, metodo) => {
  const h = {};
  if (auth) h.authorization = 'Bearer ' + auth;
  if (body) h['content-type'] = 'application/json';
  const r = await worker.fetch(new Request('https://x' + path, { method: metodo || (body ? 'POST' : 'GET'), headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.clone().json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
const TOKEN_AG = 'f'.repeat(48);
const ping = (b, tok = TOKEN_AG) => chama(tok, '/api/central/agente/ping', b || { pc: 'NOTEBOOK-BRUNO', versao: '1.0.0', servidor: false });
const resposta = (b, tok = TOKEN_AG) => chama(tok, '/api/central/agente/resposta', b);
const estado = (tk) => chama(tk, '/api/central/estado');
const pedido = (tk, b) => chama(tk, '/api/central/pedido', b);
const linhaPedido = (id) => sq.prepare('SELECT * FROM central_pedidos WHERE id = ?').get(id);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

_log('\nO AGENTE SO ENTRA COM O TOKEN DELE\n');
let r = await ping();
vale('sem token gravado na dash, o agente leva 401', r.st === 401, r.st + ' ' + JSON.stringify(r.d));
poeCfg('central_agente_token', TOKEN_AG);
r = await ping(undefined, 'e'.repeat(48));
vale('token errado leva 401', r.st === 401, String(r.st));
r = await ping(undefined, '');
vale('sem token leva 401', r.st === 401, String(r.st));
r = await chama(TK.dir, '/api/central/agente/ping', { pc: 'x' });
vale('sessao de diretor NAO serve de token do agente', r.st === 401, String(r.st));
r = await chama(TOKEN_AG, '/api/central/agente/ping', null, 'GET');
vale('ping so por POST', r.st === 405, String(r.st));

_log('\nO APP SO ENTRA COM SESSAO DA DIRECAO DA CASA\n');
r = await estado('');
vale('sem sessao: 401', r.st === 401, String(r.st));
r = await estado(TK.kev);
vale('vendedor: 403', r.st === 403, String(r.st));
r = await estado(TK.hay);
vale('cobrador: 403', r.st === 403, String(r.st));
r = await estado(TK.gio);
vale('afiliado (dono do mundo dele): 403, a central e do PC da casa', r.st === 403, String(r.st));
r = await estado(TK.dir);
vale('diretor entra', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d));
vale('sem ping nenhum ainda: PC desligado e sem retrato', r.d.pc && r.d.pc.vivo === false && r.d.estado === null, JSON.stringify(r.d));
r = await estado(TK.soc);
vale('socio da casa tambem entra', r.st === 200 && r.d.ok, String(r.st));
r = await chama(TK.dir, '/api/central/estado?como=kev');
vale('no "ver como" vendedor a central fecha (o app esta mostrando o vendedor)', r.st === 403, String(r.st));

_log('\nO RETRATO DO PC CHEGA PODADO\n');
const NUMS = [
  { nome: '32 - 15 99250-3977', numero: '15992503977', idx: 32, ligado: true, pronto: true, regerado: false, proxy: { tipo: 'http', host: 'isp.decodo.com', porta: 10001, usuario: 'spry•••', tem_senha: true, senha: 'NAO-PODE-SAIR' }, apelido: 'Proxy 11', wa: { estado: 'ativo', em: 1762700000 }, ocupado: false, tarefa: '', lixo: 'x'.repeat(50) },
  { nome: '33 - 49 98882-9124', numero: '49988829124', idx: 33, ligado: false, pronto: true, proxy: null, apelido: '', wa: null, ocupado: false, tarefa: '' },
];
r = await ping({ pc: 'NOTEBOOK-BRUNO', versao: '1.0.0', servidor: true, estado: { numeros: NUMS, tarefas: [], saude: { portaAberta: false, conferido: 1 } } });
vale('ping com token certo responde', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d));
vale('alguem olhou a tela agora: o agente fica no modo rapido', r.d.ativo === true, JSON.stringify(r.d));
vale('sem pedido na fila', Array.isArray(r.d.pedidos) && r.d.pedidos.length === 0, JSON.stringify(r.d.pedidos));
r = await estado(TK.dir);
vale('o app ve o PC ligado, com o nome dele', r.d.pc.vivo === true && r.d.pc.pc === 'NOTEBOOK-BRUNO' && r.d.pc.servidor === true, JSON.stringify(r.d.pc));
vale('e os dois celulares', r.d.estado && r.d.estado.numeros.length === 2, JSON.stringify(r.d.estado));
const n32 = r.d.estado.numeros.find((n) => n.numero === '15992503977');
vale('com o numero da Contingencia, ligado e a proxy mascarada', n32 && n32.idx === 32 && n32.ligado === true && n32.proxy.usuario === 'spry•••' && n32.proxy.porta === 10001, JSON.stringify(n32));
vale('a SENHA da proxy nunca chega na tela, nem se o PC mandar', !JSON.stringify(r.d).includes('NAO-PODE-SAIR'), JSON.stringify(n32.proxy));
vale('campo que a tela nao usa cai fora', !('lixo' in n32), Object.keys(n32).join(','));
vale('o WhatsApp do celular vem junto', n32.wa && n32.wa.estado === 'ativo', JSON.stringify(n32.wa));
vale('a saude (porta pra rede) vem junto', r.d.estado.saude && r.d.estado.saude.portaAberta === false, JSON.stringify(r.d.estado.saude));
// UM PC DOIDO NAO ENCHE O BANCO: a poda corta lista, linha e texto antes de gravar.
const grande = { numeros: Array.from({ length: 500 }, (_, i) => ({ numero: '1599' + String(1000000 + i), nome: 'x'.repeat(600), apelido: 'y'.repeat(400), proxy: { host: 'h'.repeat(800), usuario: 'u'.repeat(400), porta: 1, tem_senha: true } })), tarefas: Array.from({ length: 90 }, (_, i) => ({ id: 'a' + i, titulo: 't'.repeat(1200), linhas: Array.from({ length: 50 }, () => 'l'.repeat(3000)) })) };
r = await ping({ pc: 'NOTEBOOK-BRUNO', versao: '1.0.0', servidor: true, estado: grande });
const bruto = cfg('central_estado');
const depoisGrande = JSON.parse(bruto);
vale('retrato enorme chega podado (300 celulares, 40 tarefas, 12 linhas)', r.st === 200 && depoisGrande.numeros.length === 300 && depoisGrande.tarefas.length === 40 && depoisGrande.tarefas.every((t) => t.linhas.length === 12 && t.linhas.every((l) => l.length <= 300)), depoisGrande.numeros.length + ' / ' + depoisGrande.tarefas.length);
vale('e cabe no teto do retrato', bruto.length < 400000, String(bruto.length));
r = await ping({ pc: 'NOTEBOOK-BRUNO', versao: '1.0.0', servidor: true, estado: { numeros: NUMS, tarefas: [], saude: { portaAberta: false, conferido: 1 } } });

_log('\nCELULAR COM OUTRA PROXY (a regra da gaveta da Contingencia)\n');
poeCfg('swweb_proxies', JSON.stringify({ 1592503977: { id: 'p11', host: 'isp.decodo.com', porta: 10001, usuario: 'spryj', senha: 's' }, 4988829124: { id: 'p03', host: 'isp.decodo.com', porta: 10003 } }));
poeCfg('ldplayer_celulares', JSON.stringify({ 1592503977: { px_id: 'p11', aplicado_em: 1 }, 4988829124: { px_id: 'p02', aplicado_em: 1 } }));
r = await estado(TK.dir);
const c32 = r.d.estado.numeros.find((n) => n.numero === '15992503977');
const c33 = r.d.estado.numeros.find((n) => n.numero === '49988829124');
vale('celular montado com a proxy de hoje: sem aviso', c32 && c32.celOutra === false, JSON.stringify(c32));
vale('a dash trocou e o celular ficou com a velha: aviso', c33 && c33.celOutra === true, JSON.stringify(c33));
vale('e a senha do swweb_proxies nunca vai pro app', !JSON.stringify(r.d).includes('"senha"'), '');

_log('\nSO PASSA PEDIDO DA LISTA\n');
const recusa = async (nome, b) => { const x = await pedido(TK.dir, b); vale(nome, x.st === 400, x.st + ' ' + JSON.stringify(x.d)); };
await recusa('"Proteger agora" pelo app NAO (pede administrador na frente do PC)', { metodo: 'POST', caminho: '/api/proteger', corpo: {} });
await recusa('/api/janela NAO', { metodo: 'POST', caminho: '/api/janela', corpo: {} });
await recusa('caminho torto que vira /api/proteger NAO', { metodo: 'POST', caminho: '/api/acao/../proteger', corpo: {} });
await recusa('endereco de outro lugar NAO', { metodo: 'GET', caminho: 'https://outro.site/api/numeros' });
await recusa('//outro.site NAO', { metodo: 'GET', caminho: '//outro.site/api/numeros' });
await recusa('metodo trocado NAO (GET na rota de acao)', { metodo: 'GET', caminho: '/api/acao' });
await recusa('metodo inventado NAO', { metodo: 'DELETE', caminho: '/api/acao' });
await recusa('pagina do painel NAO (so /api)', { metodo: 'GET', caminho: '/painel?t=x' });
r = await pedido(TK.kev, { metodo: 'GET', caminho: '/api/numeros' });
vale('vendedor nao pede nada', r.st === 403, String(r.st));
const nPend = sq.prepare('SELECT COUNT(*) n FROM central_pedidos').get().n;
vale('nada disso entrou na fila', Number(nPend) === 0, String(nPend));

_log('\nO PEDIDO VAI E A RESPOSTA VOLTA\n');
const pApp = pedido(TK.dir, { metodo: 'POST', caminho: '/api/proxy', corpo: { numero: '15992503977', nome: '32 - (15) 99250-3977', proxy: 'isp.decodo.com:10009:usuario:SENHA-COLADA' } });
await espera(60);
const lpend = sq.prepare("SELECT * FROM central_pedidos WHERE status = 'pend'").all();
vale('o pedido entra na fila', lpend.length === 1, JSON.stringify(lpend));
r = await ping();
vale('o agente recebe o pedido no ping', r.d.pedidos && r.d.pedidos.length === 1 && r.d.pedidos[0].caminho === '/api/proxy' && r.d.pedidos[0].metodo === 'POST', JSON.stringify(r.d.pedidos));
const P1 = r.d.pedidos[0];
vale('com o corpo inteiro (a central precisa da proxy colada) e a idade', P1.corpo && P1.corpo.proxy === 'isp.decodo.com:10009:usuario:SENHA-COLADA' && P1.idade >= 0 && P1.idade < 5, JSON.stringify(P1));
r = await ping();
vale('o ping seguinte NAO recebe o mesmo pedido', r.d.pedidos.length === 0, JSON.stringify(r.d.pedidos));
r = await resposta({ id: P1.id, codigo: 200, resposta: { id: 'abcdef123456' } });
vale('o agente devolve a resposta', r.st === 200 && r.d.ok === true, JSON.stringify(r.d));
const rApp = await pApp;
vale('e o app recebe a resposta da central', rApp.st === 200 && rApp.d.feito === true && rApp.d.codigo === 200 && rApp.d.resposta && rApp.d.resposta.id === 'abcdef123456', JSON.stringify(rApp.d));
const l1 = linhaPedido(P1.id);
vale('a proxy colada (com a senha) SAI do banco quando termina', l1.corpo === '' && !JSON.stringify(l1).includes('SENHA-COLADA'), JSON.stringify(l1));
vale('e o id da tarefa fica guardado pro aviso', l1.tarefa === 'abcdef123456' && l1.status === 'feito', JSON.stringify(l1));
r = await resposta({ id: P1.id, codigo: 500, resposta: { erro: 'de novo' } });
vale('resposta repetida nao passa por cima da primeira', r.d.ok === false && JSON.parse(linhaPedido(P1.id).resposta).id === 'abcdef123456', JSON.stringify(linhaPedido(P1.id)));
r = await chama(TK.dir, '/api/central/pedido?id=' + P1.id);
vale('o app pode perguntar de novo pelo mesmo pedido', r.st === 200 && r.d.feito === true && r.d.resposta.id === 'abcdef123456', JSON.stringify(r.d));
// resposta de erro da central (409 "ja tem uma tarefa rodando") volta com o codigo dela
const pApp2 = pedido(TK.dir, { metodo: 'POST', caminho: '/api/acao', corpo: { acao: 'abrir', numero: '15992503977' } });
await espera(60);
r = await ping();
await resposta({ id: r.d.pedidos[0].id, codigo: 409, resposta: { erro: 'Esse número já tem uma tarefa rodando.' } });
const rApp2 = await pApp2;
vale('a recusa da central volta com o codigo e o texto dela', rApp2.d.feito === true && rApp2.d.codigo === 409 && /tarefa rodando/.test(rApp2.d.resposta.erro), JSON.stringify(rApp2.d));

// O RELOGIO PARADO DO WORKER (achado no ar em 10/11): o Date.now() la so anda entre idas ao banco, e um
// pedido que entra no meio do ping parecia ter idade -1. O carteiro recusava como "atrasado".
const adiante = sq.prepare("INSERT INTO central_pedidos (ts, por, metodo, caminho, corpo, status) VALUES (?, 'dir', 'GET', '/api/tarefas', '', 'pend') RETURNING id").get(agoraS() + 2).id;
r = await ping();
const pAd = (r.d.pedidos || []).find((p) => p.id === adiante);
vale('pedido com a hora um pouco a frente sai com idade 0, nunca negativa', pAd && pAd.idade === 0, JSON.stringify(r.d.pedidos));
await resposta({ id: adiante, codigo: 200, resposta: { tarefas: [] } });

_log('\nPEDIDO VELHO NAO RODA\n');
const velho = sq.prepare("INSERT INTO central_pedidos (ts, por, metodo, caminho, corpo, status) VALUES (?, 'dir', 'POST', '/api/acao', ?, 'pend') RETURNING id").get(agoraS() - 3600, JSON.stringify({ acao: 'excluir', numero: '15992503977', confirmacao: '3977' })).id;
r = await ping();
vale('um "excluir" de uma hora atras NAO chega no agente', !r.d.pedidos.some((p) => p.id === velho), JSON.stringify(r.d.pedidos));
vale('e fica marcado como expirado, sem o corpo', linhaPedido(velho).status === 'expirado' && linhaPedido(velho).corpo === '', JSON.stringify(linhaPedido(velho)));
r = await chama(TK.dir, '/api/central/pedido?id=' + velho);
vale('o app fica sabendo que expirou', r.d.expirado === true && /não pegou/i.test(r.d.erro), JSON.stringify(r.d));
r = await ping();
vale('e nunca mais volta pra fila', !r.d.pedidos.some((p) => p.id === velho), JSON.stringify(r.d.pedidos));
// pedido que ficou 'pend' alem do prazo enquanto o APP esperava (PC parou de pingar no meio)
const velho2 = sq.prepare("INSERT INTO central_pedidos (ts, por, metodo, caminho, corpo, status) VALUES (?, 'dir', 'GET', '/api/numeros', '', 'pend') RETURNING id").get(agoraS() - 120).id;
r = await chama(TK.dir, '/api/central/pedido?id=' + velho2);
vale('a espera do app tambem expira o pedido parado', r.d.expirado === true && linhaPedido(velho2).status === 'expirado', JSON.stringify(r.d));

_log('\nPC DESLIGADO\n');
const ag = JSON.parse(cfg('central_agente'));
poeCfg('central_agente', JSON.stringify({ ...ag, ts: agoraS() - 120 }));
r = await estado(TK.dir);
vale('o app ve o PC desligado (sem ping ha 2 min)', r.d.pc.vivo === false, JSON.stringify(r.d.pc));
vale('mas continua vendo o ultimo retrato', r.d.estado && r.d.estado.numeros.length === 2, '');
const antesN = sq.prepare('SELECT COUNT(*) n FROM central_pedidos').get().n;
r = await pedido(TK.dir, { metodo: 'POST', caminho: '/api/acao', corpo: { acao: 'abrir', numero: '15992503977' } });
vale('pedido com o PC desligado volta na hora com o aviso', r.st === 503 && r.d.offline === true && /desligado/.test(r.d.erro), r.st + ' ' + JSON.stringify(r.d));
vale('e NAO fica na fila pra rodar quando o PC ligar', sq.prepare('SELECT COUNT(*) n FROM central_pedidos').get().n === antesN, '');
await ping();

_log('\nO AGENTE SO CORRE QUANDO ALGUEM OLHA\n');
poeCfg('central_ver', JSON.stringify({ dir: agoraS() - 600, soc: agoraS() - 900 }));
r = await ping();
vale('ninguem olhou nos ultimos 90 s: modo lento', r.d.ativo === false, JSON.stringify(r.d));
await estado(TK.soc);
r = await ping();
vale('o socio abriu a tela: modo rapido', r.d.ativo === true, JSON.stringify(r.d));
const ver = JSON.parse(cfg('central_ver'));
vale('cada um no seu relogio', Number(ver.soc) >= agoraS() - 5 && Number(ver.dir) < agoraS() - 500, JSON.stringify(ver));

_log('\nO AVISO NO CELULAR QUANDO A TAREFA DO APP TERMINA\n');
const tarefa = (id, status, extra) => ({ id, titulo: 'Abrindo 32 - (15) 99250-3977', tipo: 'abrir', numero: '15992503977', status, linhas: ['ligando', 'WhatsApp Business aberto'], inicio: Date.now() - 60000, fim: status === 'rodando' ? 0 : Date.now(), ...extra });
const comTarefas = (ts) => ping({ pc: 'NOTEBOOK-BRUNO', versao: '1.0.0', servidor: true, estado: { numeros: NUMS, tarefas: ts, saude: {} } });
// o Bruno pediu e saiu da tela (central_ver velho): avisa
poeCfg('central_ver', JSON.stringify({ dir: agoraS() - 600 }));
const pA = pedido(TK.dir, { metodo: 'POST', caminho: '/api/acao', corpo: { acao: 'abrir', numero: '15992503977' } });
await espera(60);
r = await ping();
await resposta({ id: r.d.pedidos[0].id, codigo: 200, resposta: { id: '0123456789ab' } });
const rA = await pA;
const idA = rA.d.id;
poeCfg('central_ver', JSON.stringify({ dir: agoraS() - 600 }));   // ele bloqueou o celular logo depois de pedir
logs.length = 0;
await comTarefas([tarefa('0123456789ab', 'rodando')]);
vale('tarefa rodando: ninguem e avisado ainda', !logs.some((l) => /CENTRAL_AVISO/.test(l)) && linhaPedido(idA).avisado === 0, logs.join(' | '));
await comTarefas([tarefa('0123456789ab', 'pronto')]);
const aviso = logs.find((l) => /CENTRAL_AVISO/.test(l)) || '';
vale('terminou: avisa quem pediu', /CENTRAL_AVISO pedido=\d+ tarefa=0123456789ab pronto/.test(aviso), logs.join(' | '));
vale('com o celular pelo nome que ele usa ("Celular 32 - ... aberto")', /"Celular 32 - \(15\) 99250-3977 aberto"/.test(aviso), aviso);
logs.length = 0;
await comTarefas([tarefa('0123456789ab', 'pronto')]);
vale('o retrato seguinte NAO avisa de novo', !logs.some((l) => /CENTRAL_AVISO/.test(l)), logs.join(' | '));
// erro tambem avisa, com o motivo
const pB = pedido(TK.dir, { metodo: 'POST', caminho: '/api/acao', corpo: { acao: 'abrir', numero: '15992503977' } });
await espera(60);
r = await ping();
await resposta({ id: r.d.pedidos[0].id, codigo: 200, resposta: { id: 'ba9876543210' } });
await pB;
poeCfg('central_ver', JSON.stringify({ dir: agoraS() - 600 }));
logs.length = 0;
await comTarefas([tarefa('ba9876543210', 'erro', { linhas: ['ligando', 'ERRO: a proxy nao respondeu', 'o celular voltou a ficar desligado'] })]);
const avisoErro = logs.find((l) => /CENTRAL_AVISO/.test(l)) || '';
vale('erro avisa com "Nao deu certo"', /tarefa=ba9876543210 erro "Não deu certo: Abrindo 32/.test(avisoErro), avisoErro);
// quem esta com a tela aberta ja viu: sem push, mas marcado (nao avisa depois)
const pC = pedido(TK.dir, { metodo: 'POST', caminho: '/api/acao', corpo: { acao: 'desligar', numero: '15992503977' } });
await espera(60);
r = await ping();
await resposta({ id: r.d.pedidos[0].id, codigo: 200, resposta: { id: 'cccccccccccc' } });
const rC = await pC;
await estado(TK.dir);   // esta olhando
logs.length = 0;
await comTarefas([tarefa('cccccccccccc', 'pronto', { tipo: 'desligar' })]);
vale('quem esta olhando a tela NAO recebe push', !logs.some((l) => /CENTRAL_AVISO/.test(l)), logs.join(' | '));
vale('e o pedido fica marcado (nao avisa quando ele sair)', linhaPedido(rC.d.id).avisado === 1, JSON.stringify(linhaPedido(rC.d.id)));
// tarefa que a JANELA DO PC disparou (nenhum pedido do app aponta pra ela): ninguem e avisado
logs.length = 0;
await comTarefas([tarefa('dddddddddddd', 'pronto')]);
vale('tarefa disparada pela janela do PC nao avisa ninguem', !logs.some((l) => /CENTRAL_AVISO/.test(l)), logs.join(' | '));

_log('\nO RETRATO E O ESTADO DO PC\n');
r = await ping({ pc: 'NOTEBOOK-BRUNO', versao: '1.0.1', servidor: false });
r = await estado(TK.dir);
vale('o app ve quando o painel do PC esta fechado (sobe no proximo pedido)', r.d.pc.servidor === false && r.d.pc.versao === '1.0.1', JSON.stringify(r.d.pc));

console.log = _log;
_log('\n' + ok + ' ok, ' + falhas.length + ' falha(s)');
if (falhas.length) { _log('FALHAS:\n - ' + falhas.join('\n - ')); process.exit(1); }
