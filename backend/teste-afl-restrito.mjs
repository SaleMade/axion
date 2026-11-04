// TESTE DA RESTRICAO DE AFILIADO (03/11/2026, pedido do Bruno: o afiliado para de subir pedido e
// passa a so acompanhar o que ja vendeu).
//
// Roda o codigo DE VERDADE: recorta do worker.js o bloco da restricao (a marca no app_config, a
// pergunta "esta restrito agora?", a lista branca de rotas e o gate do roteador) e o _aflRestrAplica,
// e monta tudo com dependencias de mentira (banco, autenticacao). Se alguem mexer na regra ou mudar
// o nome de uma funcao, este teste quebra junto.
//   node teste-afl-restrito.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// O bloco inteiro da restricao e contiguo no arquivo: da marca no app_config ate o gate do roteador.
function recortaBloco(de, ate) {
  const i = src.indexOf(de);
  const j = src.indexOf(ate, i + 1);
  if (i < 0 || j < 0) throw new Error('nao achei o bloco entre "' + de + '" e "' + ate + '"');
  return src.slice(i, j);
}
function recortaFuncao(nome) {
  const a = src.indexOf('\nasync function ' + nome + '(');
  const i = a >= 0 ? a : src.indexOf('\nfunction ' + nome + '(');
  if (i < 0) throw new Error('nao achei a funcao ' + nome + ' no worker.js');
  const j = src.indexOf('{', src.indexOf('(', i + 1));
  let n = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') n++;
    else if (src[k] === '}') { n--; if (!n) return src.slice(i + 1, k + 1); }
  }
  throw new Error('chave nao fecha em ' + nome);
}
const BLOCO = recortaBloco('const _AFL_RESTR_PREF', '// QUEM PODE MEXER NA PRESSEL');
for (const esperado of ['_aflRestrTodos', '_aflRestrDesde', '_restritoAgora', '_restrLiberado', '_gateRestrito', '_RESTR_OK_EXATO']) {
  if (BLOCO.indexOf(esperado) < 0) throw new Error('o bloco recortado nao tem ' + esperado + ' (alguem mudou o arquivo de lugar?)');
}
const CODIGO = BLOCO + '\n' + recortaFuncao('_aflRestrAplica');

// ── o mundo de mentira ────────────────────────────────────────────────────────
// `config` e a tabela app_config; `sessoes` conta quantas sessoes existem por mundo.
function monta(config, sessoes) {
  const cfg = { ...(config || {}) };
  const ses = { ...(sessoes || {}) };
  const banco = { cfg, ses, lidas: 0 };
  const env = {
    DB: {
      prepare(sql) {
        const st = {
          _args: [],
          bind(...a) { st._args = a; return st; },
          async first() {
            if (/SELECT value FROM app_config/.test(sql)) {
              const k = String(st._args[0]);
              return Object.prototype.hasOwnProperty.call(cfg, k) ? { value: cfg[k] } : null;
            }
            return null;
          },
          async all() {
            if (/SELECT key, value FROM app_config WHERE key LIKE/.test(sql)) {
              banco.lidas++;
              const pref = String(st._args[0]).replace(/%$/, '');
              return { results: Object.keys(cfg).filter((k) => k.startsWith(pref)).map((k) => ({ key: k, value: cfg[k] })) };
            }
            return { results: [] };
          },
          async run() {
            if (/DELETE FROM app_config/.test(sql)) { delete cfg[String(st._args[0])]; return { meta: { changes: 1 } }; }
            if (/INSERT INTO app_config/.test(sql)) { cfg[String(st._args[0])] = String(st._args[1]); return { meta: { changes: 1 } }; }
            if (/DELETE FROM sessions/.test(sql)) {
              const id = String(st._args[0]);
              const n = Number(ses[id]) || 0; ses[id] = 0;
              return { meta: { changes: n } };
            }
            return { meta: { changes: 0 } };
          },
        };
        return st;
      },
    },
  };
  return { banco, env };
}
const logs = [];
// `quem` e o usuario que o authUser de mentira devolve (null = sem sessao).
const fazer = (quem) => new Function('logs', 'quem', `
  const isDirector = (u) => ['diretor','socio','produtor'].includes(String((u && u.role) || ''));
  const aflDe = (u) => (u && u.afiliado_id) ? String(u.afiliado_id) : null;
  const isAfiliado = (u) => String((u && u.role) || '') === 'afiliado';
  const noMundoAfiliado = (u) => !isDirector(u) && !!aflDe(u);
  const afiliadoSemVinculo = (u) => isAfiliado(u) && !aflDe(u);
  const authUser = async () => quem;
  const err = (m, s) => ({ erro: m, status: s || 400, _recusa: true });
  const _ensureConfigTable = async () => {};
  const _readConfig = async (env, k) => { const r = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?').bind(k).first(); return (r && r.value) || null; };
  const _writeConfig = async (env, k, v) => { if (!v) { await env.DB.prepare('DELETE FROM app_config WHERE key = ?').bind(k).run(); return; } await env.DB.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?,?,0)').bind(k, v).run(); };
  const console = { log: (s) => logs.push(String(s)) };
  ${CODIGO}
  return { _aflRestrTodos, _aflRestrDesde, _restritoAgora, _restrLiberado, _gateRestrito, _aflRestrAplica, _aflRestrEsquece };`)(logs, quem);

const AGORA = Math.floor(Date.now() / 1000);
const PASSADO = JSON.stringify({ desde: AGORA - 3600, por: 'dir', em: AGORA - 7200 });
const FUTURO = JSON.stringify({ desde: AGORA + 3600, por: 'dir', em: AGORA });
const GIO = { id: 'afiliado_fdmx9z', login: 'giovane', role: 'afiliado', afiliado_id: 'afl_3d767329' };
const VEND_GIO = { id: 'atendente_awpftn', login: 'thariky', role: 'atendente', afiliado_id: 'afl_3d767329' };
const DIR = { id: 'dir', login: 'bruno', role: 'diretor' };
const VEND_CASA = { id: 'atendente_6e3cbf', login: 'kevin', role: 'atendente' };
const req = (metodo, token) => ({ method: metodo, headers: { get: (h) => (String(h).toLowerCase() === 'authorization' && token !== null ? 'Bearer ' + 'a'.repeat(64) : '') } });

let ok = 0, falhou = 0;
const conf = (nome, vale) => { if (vale) { ok++; } else { falhou++; console.log('  FALHOU: ' + nome); } };

// ── 1) a marca: sem chave ninguem e restrito ──────────────────────────────────
{
  const { env } = monta({});
  const f = fazer(GIO);
  conf('sem chave, o afiliado nao esta restrito', (await f._restritoAgora(env, GIO)) === false);
  conf('sem chave, desde = 0', (await f._aflRestrDesde(env, 'afl_3d767329')) === 0);
}
// ── 2) marcado pra DEPOIS: hoje ainda nao vale ────────────────────────────────
{
  const { env } = monta({ afl_restr_afl_3d767329: FUTURO });
  const f = fazer(GIO);
  conf('marcado pra meia-noite, agora nao vale', (await f._restritoAgora(env, GIO)) === false);
  conf('mas a data esta guardada', (await f._aflRestrDesde(env, 'afl_3d767329')) === AGORA + 3600);
}
// ── 3) a hora passou: vale pro afiliado E pra equipe dele ─────────────────────
{
  const { env } = monta({ afl_restr_afl_3d767329: PASSADO });
  const f = fazer(GIO);
  conf('passou da hora: o afiliado esta restrito', (await f._restritoAgora(env, GIO)) === true);
  conf('a vendedora dele tambem', (await f._restritoAgora(env, VEND_GIO)) === true);
  conf('o diretor nunca', (await f._restritoAgora(env, DIR)) === false);
  conf('vendedor da casa nunca', (await f._restritoAgora(env, VEND_CASA)) === false);
  conf('outro afiliado nao marcado fica livre', (await f._restritoAgora(env, { ...GIO, afiliado_id: 'afl_outro' })) === false);
}
// ── 4) numero cru no lugar do JSON tambem vale (marca escrita na mao) ─────────
{
  const { env } = monta({ afl_restr_afl_3d767329: String(AGORA - 10) });
  const f = fazer(GIO);
  conf('valor cru em segundos funciona', (await f._restritoAgora(env, GIO)) === true);
}
// ── 5) a marca "_aplicado" nao e restricao ────────────────────────────────────
{
  const { env } = monta({ afl_restr_afl_3d767329_aplicado: String(AGORA - 10) });
  const f = fazer(GIO);
  conf('a marca de sessao derrubada nao restringe ninguem', (await f._restritoAgora(env, GIO)) === false);
}
// ── 6) a lista branca de rotas ────────────────────────────────────────────────
{
  const f = fazer(GIO);
  const PASSA = [['GET', '/api/state'], ['POST', '/api/state'], ['GET', '/api/state/pulso'],
    ['POST', '/auth/login'], ['GET', '/auth/me'], ['POST', '/auth/logout'],
    ['POST', '/api/lead/123'], ['POST', '/api/lead/123/move'], ['GET', '/api/lead/123/comments'],
    ['POST', '/api/lead/123/agend'], ['GET', '/api/five/orders'], ['GET', '/api/five/summary'],
    ['GET', '/api/users'], ['GET', '/api/arquivo/comprovante%2F1%2Fx.mp4'], ['POST', '/api/push/sub'],
    ['GET', '/api/leads/contagem'], ['POST', '/api/tags/save'], ['POST', '/api/coment-prontos'],
    ['GET', '/api/wa/sales'], ['GET', '/api/podio'],
    // A PRESSEL VOLTOU PRA ELE EM 04/11/2026 (pedido do Bruno). A tela e uma so: a pressel e os
    // numeros da roleta, por isso /api/chip/ entra junto. O dono continua sendo conferido dentro
    // de cada handler (_podeMexerPressel, _presselIdsVisiveis, chip do mesmo `afl`).
    ['GET', '/api/pressel/meus'], ['GET', '/api/pressel/metrics'], ['GET', '/api/pressel/diag'],
    ['POST', '/api/pressel/save'], ['POST', '/api/pressel/delete'], ['POST', '/api/pressel/num'],
    ['POST', '/api/pressel/meu-numero'], ['POST', '/api/chip/save'], ['POST', '/api/chip/create'],
    ['POST', '/api/chip/ordem'], ['GET', '/api/wa/conn'],
    // A CONTINGENCIA VOLTOU COM PRAZO (04/11/2026, sai em 18/11): e por ela que ele desliga um
    // numero que caiu enquanto faz a migracao.
    ['POST', '/api/cont/save']];
  for (const [m, p] of PASSA) conf('passa ' + m + ' ' + p, f._restrLiberado(p, m) === true);
  const BARRA = [['POST', '/api/pedido/novo'], ['GET', '/api/pedido/mesmo-cpf'],
    // O detector de dominios NAO voltou: a tela dele nem chama.
    ['POST', '/api/pressel/domains/detect'], ['GET', '/api/wa/chats'],
    ['GET', '/api/wa/messages'], ['POST', '/api/wa/cloud/send'], ['POST', '/api/wa/conn'],
    ['GET', '/api/wa/instances'], ['GET', '/api/salechat'], ['POST', '/api/salechat/save'],
    ['POST', '/api/users'], ['POST', '/api/saque/create'], ['GET', '/api/swweb/numeros'],
    ['GET', '/api/bot/config'], ['POST', '/api/tt/reenviar'], ['GET', '/api/conexoes'],
    ['POST', '/api/acl/save'], ['GET', '/api/cs/extrato'], ['POST', '/api/short'],
    ['POST', '/api/wa/sales'], ['POST', '/api/users/x'], ['GET', '/api/afiliados']];
  for (const [m, p] of BARRA) conf('barra ' + m + ' ' + p, f._restrLiberado(p, m) === false);
}
// ── 7) o gate do roteador ─────────────────────────────────────────────────────
{
  const { env } = monta({ afl_restr_afl_3d767329: PASSADO });
  const barrado = async (quem, metodo, caminho, token = 'x') => {
    const f = fazer(quem);
    const r = await f._gateRestrito(req(metodo, token === null ? null : token), env, caminho);
    return !!(r && r._recusa && r.status === 403);
  };
  conf('restrito nao abre o inbox', await barrado(GIO, 'GET', '/api/wa/chats'));
  conf('restrito nao cadastra pedido', await barrado(GIO, 'POST', '/api/pedido/novo'));
  conf('restrito nao cria usuario', await barrado(GIO, 'POST', '/api/users'));
  conf('restrito MEXE na Contingencia dele (ate 18/11/2026)', (await barrado(GIO, 'POST', '/api/cont/save')) === false);
  conf('restrito continua sem o detector de dominios', await barrado(GIO, 'POST', '/api/pressel/domains/detect'));
  conf('restrito MEXE na pressel dele (devolvida em 04/11/2026)', (await barrado(GIO, 'POST', '/api/pressel/save')) === false);
  conf('e nos numeros da roleta dele', (await barrado(GIO, 'POST', '/api/chip/save')) === false);
  conf('a vendedora dele tambem nao', await barrado(VEND_GIO, 'GET', '/api/wa/chats'));
  conf('restrito ABRE o estado', (await barrado(GIO, 'GET', '/api/state')) === false);
  conf('restrito ABRE o pedido dele', (await barrado(GIO, 'POST', '/api/lead/123/move')) === false);
  conf('restrito ABRE o nome do time', (await barrado(GIO, 'GET', '/api/users')) === false);
  conf('o diretor passa em tudo', (await barrado(DIR, 'POST', '/api/wa/cloud/send')) === false);
  conf('vendedor da casa passa em tudo', (await barrado(VEND_CASA, 'POST', '/api/pedido/novo')) === false);
  conf('rota publica nem consulta sessao', (await barrado(GIO, 'GET', '/pressels-total.json')) === false);
  conf('sem Bearer o gate nao decide nada', (await barrado(GIO, 'GET', '/api/wa/chats', null)) === false);
  conf('cada recusa deixa rastro no log', logs.filter((l) => l.startsWith('AFL_RESTRITO barrou')).length >= 5);
}
// ── 8) marcado pra DEPOIS: o gate deixa trabalhar hoje ────────────────────────
{
  const { env } = monta({ afl_restr_afl_3d767329: FUTURO });
  const f = fazer(GIO);
  const r = await f._gateRestrito(req('POST', 'x'), env, '/api/pedido/novo');
  conf('antes da hora, cadastra normal', r === null);
}
// ── 9) a sessao cai UMA vez, quando a hora chega ──────────────────────────────
{
  const { banco, env } = monta({ afl_restr_afl_3d767329: PASSADO }, { afl_3d767329: 3 });
  const f = fazer(DIR);
  const n1 = await f._aflRestrAplica(env);
  conf('derruba as 3 sessoes do mundo dele', n1 === 3);
  conf('e marca que ja aplicou', String(banco.cfg.afl_restr_afl_3d767329_aplicado) === String(AGORA - 3600));
  banco.ses.afl_3d767329 = 2;   // ele entrou de novo, agora com a dash restrita
  const n2 = await f._aflRestrAplica(env);
  conf('nao derruba de novo na batida seguinte', n2 === 0 && banco.ses.afl_3d767329 === 2);
  // Data trocada = restricao nova: aplica outra vez.
  banco.cfg.afl_restr_afl_3d767329 = JSON.stringify({ desde: AGORA - 60, por: 'dir', em: AGORA });
  f._aflRestrEsquece();
  const n3 = await f._aflRestrAplica(env);
  conf('data nova aplica de novo', n3 === 2);
}
// ── 10) marcado pra depois: nada cai agora ────────────────────────────────────
{
  const { banco, env } = monta({ afl_restr_afl_3d767329: FUTURO }, { afl_3d767329: 2 });
  const f = fazer(DIR);
  conf('antes da hora ninguem e deslogado', (await f._aflRestrAplica(env)) === 0 && banco.ses.afl_3d767329 === 2);
}
// ── 11) o mapa e lido uma vez por minuto, nao por requisicao ──────────────────
{
  const { banco, env } = monta({ afl_restr_afl_3d767329: PASSADO });
  const f = fazer(GIO);
  for (let i = 0; i < 20; i++) await f._restritoAgora(env, GIO);
  conf('20 perguntas, 1 consulta ao banco', banco.lidas === 1);
}
// ── 12) banco mudo nao tranca o afiliado fora dos pedidos dele ────────────────
{
  const env = { DB: { prepare() { return { bind() { return this; }, async all() { throw new Error('D1 overloaded'); }, async first() { throw new Error('D1 overloaded'); }, async run() { throw new Error('D1 overloaded'); } }; } } };
  const f = fazer(GIO);
  conf('erro de banco = ninguem restrito (e um log)', (await f._restritoAgora(env, GIO)) === false);
  conf('o erro aparece no log', logs.some((l) => l.startsWith('AFL_RESTR leitura falhou')));
}

console.log((falhou ? 'FALHOU' : 'OK') + ': ' + ok + ' de ' + (ok + falhou) + ' conferencias');
process.exit(falhou ? 1 : 0);
