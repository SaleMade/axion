// ROLETA: CHIP DA CASA SEM API SO RECEBE COM O PROPRIO NUMERO ABERTO NO APP (18/10/2026, antes da migracao de 19/10).
//
// Tres furos, conferidos com as funcoes reais e o D1 real antes do conserto:
//  1) o chip da casa sem API passava pelo _servConnOk GENERICO, que aprova pela linha do numero em wa_api_numbers com
//     o app FECHADO (desmarcar API no chip nao mexe nessa linha; o cron leva ate ~80 min pra marcar DISCONNECTED). O
//     erro era meu, de 17/10; achado da sessao 2d. A regra do Bruno (17/10): "a roleta nao pode mandar clique pra
//     numero fechado";
//  2) o _presselLiveSet devolvia o mesmo null pra "a leitura falhou" e pra "li e nao tem ninguem vivo", e null aprova
//     tudo: a noite, com os apps fechados, todo numero Em uso da casa voltava pra roleta (51 de 51 no estado de 18/10);
//  3) o clique pago montava o liveSet sem carregar o _apiMorto (numero banido aberto no app passava).
// E o estado que o app reporta (swweb_conn: bloqueado, conflito, proxy, versao) passou a tirar o numero.
//
// Le as funcoes DO PROPRIO worker.js (recorta e avalia; _chipAquecendo/_numDoAquecimento e o env.DB sao dubles) e
// roda a roleta de verdade (_resolvePresselSellers) e o _presselLiveSet de verdade por cima. Copia da logica
// testaria a copia.
//
//   node teste-roleta-casa-app-fechado.mjs            (o worker.js desta pasta)
//   WORKER=<caminho> node teste-roleta-casa-app-fechado.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const fonte = fs.readFileSync(process.env.WORKER || path.join(AQUI, 'worker.js'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
// recorta uma funcao inteira (async ou nao) pelo casamento das chaves
function funcao(nome) {
  let i = fonte.indexOf('\nfunction ' + nome + '(');
  if (i < 0) i = fonte.indexOf('\nasync function ' + nome + '(');
  if (i < 0) return null;
  const j = fonte.indexOf('{', fonte.indexOf('(', i));
  let nivel = 0;
  for (let k = j; k < fonte.length; k++) {
    const ch = fonte[k];
    if (ch === '{') nivel++;
    else if (ch === '}') { nivel--; if (nivel === 0) return fonte.slice(i + 1, k + 1); }
  }
  return null;
}
const linha = (inicio) => fonte.split('\n').find((l) => l.startsWith(inicio)) || null;

let ok = 0;
const falhas = [];
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome); }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')); }
};

const nomes = ['_lastDigitsEq', '_waNumKey', '_servConnOk', '_modoRoleta', '_vivoNoApp', '_chipVivo', '_resolvePresselSellers', '_presselLiveSet', '_carregaApiMorto'];
const blocos = nomes.map((n) => [n, funcao(n)]);
const constFora = linha('const _SWWEB_ST_FORA = ');
const faltando = blocos.filter(([, b]) => !b).map(([n]) => n).concat(constFora ? [] : ['_SWWEB_ST_FORA']);
conta('o worker tem o helper unico da regra e o filtro do estado do app', !faltando.length, 'faltando: ' + faltando.join(', '));
if (faltando.length) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1); }

const fabrica = new Function('apiMortoInicial', '_chipAquecendo', '_numDoAquecimento',
  'let _apiMorto = apiMortoInicial; let _apiMortoEm = 0;\n' + constFora + '\n' + blocos.map(([, b]) => b).join('\n')
  + '\nreturn { _servConnOk, _modoRoleta, _vivoNoApp, _chipVivo, _resolvePresselSellers, _presselLiveSet, morto: () => _apiMorto };');
const apiMorto = new Set();
const F = fabrica(apiMorto, () => false, () => null);

// numeros de mentira: casa (dono 'guilherme'), API oficial e afiliado
const GUI = '1574076200', MIGRADO = '1592428200', OUTRO = '1181316267', AFL = '1199990000';
const liveSet = (pares) => new Map(pares);
const chipCasa = { num: '15' + '9' + MIGRADO.slice(2), at: 'guilherme', wa_st: 'em_uso' };   // (15) 99242-8200, sem api, sem afl
const k8 = (n) => String(n).replace(/\D/g, '').slice(-8);

console.log('ROLETA: CHIP DA CASA SEM API (O QUE O BRUNO MIGRA DA API PRO APP)\n');
{
  const ls = liveSet([['ax_guilherme_' + k8(MIGRADO), '55' + MIGRADO], ['ax_guilherme_' + k8(GUI), '55' + GUI]]);
  conta('app FECHADO + linha antiga em wa_api_numbers -> NAO recebe', F._chipVivo(ls, chipCasa, 'ax_guilherme') === false);
  conta('(o _servConnOk generico aprovaria: e o furo)', F._servConnOk(ls, 'ax_guilherme', chipCasa.num) === true);
}
{
  // DEFESA: hoje nenhum escritor grava wa_conn 'ax_<at>' sem numero (conferido em 18/10), mas se um dia gravar, o
  // fail-open do slot nao pode aprovar numero fechado
  const ls = liveSet([['ax_guilherme', ''], ['ax_outro_' + k8(OUTRO), '55' + OUTRO]]);
  conta('(defesa) slot ax_<at> vivo sem numero nao aprova numero fechado', F._chipVivo(ls, chipCasa, 'ax_guilherme') === false);
}
{
  const ls = liveSet([['sc_55' + MIGRADO, '55' + MIGRADO]]);
  conta('app ABERTO (sc_<numero>) -> recebe', F._chipVivo(ls, chipCasa, 'ax_guilherme') === true);
}
{
  apiMorto.add('15' + MIGRADO.slice(-8));
  const ls = liveSet([['sc_55' + MIGRADO, '55' + MIGRADO]]);
  conta('app ABERTO mas BANIDO na Meta -> NAO recebe', F._chipVivo(ls, chipCasa, 'ax_guilherme') === false);
  apiMorto.clear();
}
{
  const ls = liveSet([['sc_55' + GUI, '55' + GUI]]);
  conta('outro numero do vendedor aberto no app -> este NAO recebe', F._chipVivo(ls, chipCasa, 'ax_guilherme') === false);
}
conta('liveSet nulo (a LEITURA FALHOU) -> continua recebendo (fail-open)', F._chipVivo(null, chipCasa, 'ax_guilherme') === true);
conta('liveSet vazio (LEU e ninguem esta vivo) -> NAO recebe', F._chipVivo(new Map(), chipCasa, 'ax_guilherme') === false);
conta('chip sem numero -> nao recebe', F._chipVivo(liveSet([['sc_x', '1']]), { at: 'guilherme' }, 'ax_guilherme') === false);

console.log('\nO QUE NAO MUDA\n');
{
  const chipApi = { num: '55' + GUI, at: 'guilherme', api: true, wa_st: 'em_uso' };
  const ls = liveSet([['ax_guilherme_' + k8(GUI), '55' + GUI]]);
  conta('chip de API oficial continua vivo pela linha da API', F._chipVivo(ls, chipApi, 'ax_guilherme') === true);
  conta('chip de API sem linha nem app continua fora (como hoje)', F._chipVivo(liveSet([['ax_outro_' + k8(OUTRO), '55' + OUTRO]]), chipApi, 'ax_guilherme') === false);
}
{
  const chipAfl = { num: '55' + AFL, at: 'vend_afl', afl: 'afl_3d767329', wa_st: 'em_uso' };
  conta('chip de AFILIADO sem API (roleta) continua sem exigir conexao', F._chipVivo(liveSet([['ax_outro_' + k8(OUTRO), '55' + OUTRO]]), chipAfl, 'ax_vend_afl') === true);
  conta('chip de AFILIADO sem API continua distribuindo mesmo com o liveSet vazio', F._chipVivo(new Map(), chipAfl, 'ax_vend_afl') === true);
  const chipAflSc = { ...chipAfl, conn: 'sc' };
  conta('chip de afiliado no Sale Chat continua no _servConnOk (heartbeat dele aprova)', F._chipVivo(liveSet([['sc_55' + AFL, '55' + AFL]]), chipAflSc, 'ax_vend_afl') === true);
}

console.log('\nA ROLETA DE VERDADE (_resolvePresselSellers) COM O APP FECHADO E ABERTO\n');
{
  const p = { id: 'p1', vendedores: [{ at: 'guilherme' }] };
  const chips = [{ ...chipCasa }, { num: '55' + GUI, at: 'guilherme', api: true, wa_st: 'em_uso' }];
  const fora = new Set(['restrito', 'banido']);
  const fechado = liveSet([['ax_guilherme_' + k8(MIGRADO), '55' + MIGRADO], ['ax_guilherme_' + k8(GUI), '55' + GUI]]);
  const numsF = ((F._resolvePresselSellers(p, chips, fechado, new Set(), fora, new Set())[0] || {}).nums || []).map((n) => k8(n.num));
  conta('app fechado: a roleta entrega so o numero de API, nunca o migrado', numsF.length === 1 && numsF[0] === k8(GUI), JSON.stringify(numsF));
  const aberto = new Map([...fechado, ['sc_55' + MIGRADO, '55' + MIGRADO]]);
  const numsA = ((F._resolvePresselSellers(p, chips, aberto, new Set(), fora, new Set())[0] || {}).nums || []).map((n) => k8(n.num)).sort();
  conta('app aberto: o migrado volta pra roleta junto com o de API', JSON.stringify(numsA) === JSON.stringify([k8(GUI), k8(MIGRADO)].sort()), JSON.stringify(numsA));
  const sZ = F._resolvePresselSellers(p, [{ ...chipCasa }], fechado, new Set(), fora, new Set());
  conta('so o migrado, app fechado: o vendedor sai da roleta (a pressel cai no aviso "sem numero")', sZ.length === 0, JSON.stringify(sZ));
}

console.log('\nO _presselLiveSet DE VERDADE, COM UM BANCO DE MENTIRA\n');
// banco falso: responde pelo texto do SQL; `quebra` faz o batch e as consultas soltas falharem
function bancoFalso({ conn = [], hb = [], api = [], banidos = [], estados = [], quebra = false } = {}) {
  const resp = (sql) => {
    if (/FROM wa_conn/.test(sql)) return { results: conn };
    if (/FROM sc_heartbeat/.test(sql)) return { results: hb };
    if (/FROM swweb_conn/.test(sql)) return { results: estados };
    if (/status,''\) = 'BANNED'/.test(sql)) return { results: banidos };
    if (/FROM wa_api_numbers/.test(sql)) return { results: api };
    return { results: [] };
  };
  const soltas = [];   // consultas feitas FORA do batch (cada uma e uma ida a mais ao banco no clique pago)
  return {
    soltas,
    DB: {
      prepare(sql) {
        const st = { sql, all: async () => { soltas.push(sql); if (quebra) throw new Error('D1 fora'); return resp(sql); }, bind: () => st };
        return st;
      },
      batch: async (stmts) => { if (quebra) throw new Error('D1 fora'); return stmts.map((x) => resp(x.sql)); },
    },
  };
}
{
  const env = bancoFalso();
  const ls = await F._presselLiveSet(env);
  conta('leu tudo e nao tem ninguem vivo -> Map VAZIO (nao null)', ls instanceof Map && ls.size === 0, String(ls));
  conta('... e com ele o numero da casa fechado NAO recebe', F._chipVivo(ls, chipCasa, 'ax_guilherme') === false);
}
{
  const env = bancoFalso({ quebra: true });
  const ls = await F._presselLiveSet(env);
  conta('a leitura FALHOU -> null (o fail-open de sempre)', ls === null, String(ls));
}
{
  const env = bancoFalso({ hb: [{ self_number: '55' + MIGRADO }], banidos: [{ display_phone: '55' + MIGRADO }] });
  const ls = await F._presselLiveSet(env);
  conta('o clique pago carrega os BANIDOS na mesma ida ao banco', F.morto().has('15' + MIGRADO.slice(-8)), JSON.stringify([...F.morto()]));
  conta('... e o numero banido aberto no app NAO recebe', F._chipVivo(ls, chipCasa, 'ax_guilherme') === false);
  conta('o clique pago continua sendo UMA ida ao banco (nenhuma consulta fora do batch)', env.soltas.length === 0, JSON.stringify(env.soltas));
}
{
  const hbM = [{ self_number: '55' + MIGRADO }];
  const ruim = await F._presselLiveSet(bancoFalso({ hb: hbM, conn: [{ instance: 'ax_guilherme', number: '55' + MIGRADO }], estados: [{ nk: '15' + MIGRADO.slice(-8) }] }));
  conta('app reporta bloqueado/conflito: o numero sai do liveSet (heartbeat e wa_conn)', !!ruim && ![...ruim.values()].some((v) => k8(v) === k8(MIGRADO)), JSON.stringify([...ruim]));
  conta('... e NAO recebe', F._chipVivo(ruim, chipCasa, 'ax_guilherme') === false);
  const bom = await F._presselLiveSet(bancoFalso({ hb: hbM }));
  conta('sem estado ruim, o mesmo heartbeat deixa receber', F._chipVivo(bom, chipCasa, 'ax_guilherme') === true);
  conta('os estados que tiram sao bloqueado, conflito, proxy e versao (nao caiu, qr nem offline)', /\('bloqueado','conflito','proxy','versao'\)/.test(constFora), constFora);
}

console.log('\nAS TRES COPIAS DA REGRA USAM O MESMO HELPER\n');
conta('a roleta usa _chipVivo', /if\(!_chipVivo\(liveSet, c, instP\)\) continue;/.test(fonte));
conta('o campo roleta e o vivo do GET /api/swweb/numeros usam _chipVivo', (fonte.match(/_chipVivo\(liveSet, c, 'ax_' \+ String\(c\.at \|\| ''\)\)/g) || []).length === 2);
conta('o motivo da Chegada de leads usa _chipVivo', /const conectados = ligados\.filter\(c=>_chipVivo\(liveSet, c, 'ax_'\+String\(c\.at\)\)\);/.test(fonte));
conta('nenhuma decisao de chip ficou no _servConnOk solto', !/_modoRoleta\(c\) \|\| _servConnOk\(|!roleta && !_servConnOk\(|ligados\.filter\(c=>_servConnOk\(/.test(fonte));

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) process.exit(1);
