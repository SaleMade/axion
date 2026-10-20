// ROLETA: QUEM MANDA NO CHIP DA CASA E O INTERRUPTOR DA PRESSEL (regra de 20/10/2026).
//
// ATENCAO, A REGRA DESTE ARQUIVO JA FOI O CONTRARIO. Entre 18/10 e 20/10 chip da casa so recebia com
// o proprio numero ABERTO no app, por pedido do Bruno em 17/10 ("a roleta nao pode mandar clique pra
// numero fechado"). Em 20/10 ele desfez, com o motivo do negocio: vendedor que sai pro almoco e fecha
// o app fazia os leads caírem todos no colega, e ele prefere achar os leads esperando quando voltar.
// NAO "conserte" isto de volta sem falar com ele: o nome do arquivo e historico, a regra e a de cima.
//
// O que tornou seguro desfazer: mensagem que chega com o app fechado nao se perde, porque o
// _waLeadCapture aceita mensagem atrasada de ate 24 h com codigo de desconto nao reivindicado
// (ver teste-lead-atrasado.mjs). O custo aceito por ele: numero fechado acumula conversa sem
// resposta, e tempo de resposta derruba conversao.
//
// HISTORICO DOS TRES FUROS que criaram a regra antiga (valem como medicao, nao como regra):
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

console.log('ROLETA: QUEM MANDA NO CHIP DA CASA E O INTERRUPTOR DA PRESSEL\n');
{
  // A REGRA VIROU EM 20/10/2026, A PEDIDO DO BRUNO. Ate hoje de manha chip da casa so recebia com o
  // proprio numero ABERTO no app (regra dele mesmo, de 17/10: "a roleta nao pode mandar clique pra
  // numero fechado"). Ele desfez com o motivo do negocio: "meus vendedores as vezes saem para almoco
  // e deixam um fechado. Quando retornarem, quero que ja tenham os leads ali. Isso tambem e ruim
  // porque um fecha e o outro recebe muitos leads, e fica esse desparelhamento. Se um numero esta
  // ativo na Pressel, e porque ele vai receber. So se ele ficar desativado e que para."
  //
  // O QUE TORNA ISSO SEGURO: mensagem que chega com o app fechado NAO se perde. O _waLeadCapture
  // aceita mensagem atrasada de ate 24 h com codigo de desconto de clique nao reivindicado (ver
  // teste-lead-atrasado.mjs), entao o lead e capturado quando o vendedor reabre o app.
  const ls = liveSet([['ax_guilherme_' + k8(MIGRADO), '55' + MIGRADO], ['ax_guilherme_' + k8(GUI), '55' + GUI]]);
  conta('app FECHADO -> RECEBE (o vendedor acha os leads quando voltar do almoco)', F._chipVivo(ls, chipCasa, 'ax_guilherme') === true);
  conta('app ABERTO -> recebe', F._chipVivo(liveSet([['sc_55' + MIGRADO, '55' + MIGRADO]]), chipCasa, 'ax_guilherme') === true);
  conta('ninguem vivo no mundo inteiro -> recebe do mesmo jeito', F._chipVivo(new Map(), chipCasa, 'ax_guilherme') === true);
  conta('a leitura de conexao falhou (null) -> recebe', F._chipVivo(null, chipCasa, 'ax_guilherme') === true);
  conta('so OUTRO numero do vendedor aberto -> este recebe assim mesmo', F._chipVivo(liveSet([['sc_55' + GUI, '55' + GUI]]), chipCasa, 'ax_guilherme') === true);
}
{
  // O UNICO "NAO" QUE SOBROU, e e o que ele pediu pra manter: banido na Meta. Dos 25 numeros da casa,
  // oito estao BANNED. Agora nao ha mais nenhum outro filtro embaixo, entao esta checagem e a ultima
  // linha de defesa: clique pago indo pra numero banido e dinheiro no lixo.
  apiMorto.add('15' + MIGRADO.slice(-8));
  conta('BANIDO na Meta -> NAO recebe, nem com o app aberto', F._chipVivo(liveSet([['sc_55' + MIGRADO, '55' + MIGRADO]]), chipCasa, 'ax_guilherme') === false);
  conta('BANIDO na Meta -> NAO recebe com o app fechado', F._chipVivo(new Map(), chipCasa, 'ax_guilherme') === false);
  apiMorto.clear();
  conta('tirado da lista de banidos, volta a receber', F._chipVivo(new Map(), chipCasa, 'ax_guilherme') === true);
}
conta('chip SEM numero -> nao recebe (nao ha pra onde mandar)', F._chipVivo(liveSet([['sc_x', '1']]), { at: 'guilherme' }, 'ax_guilherme') === false);

console.log('\nA MARCA `api` NAO PESA MAIS (20/10/2026)\n');
{
  // Decisao do mesmo dia, horas antes: "a API oficial a gente nao vai usar mais; independente do
  // numero estar ou nao com API, quero que mande pra aquele numero". Era o caso do (47) 99740-5847 do
  // Kevin e do (11) 96663-2248 do Guilherme: DISCONNECTED na Meta, abertos e funcionando no app, e a
  // roleta pulava os dois calada. Como sao o PRIMEIRO da fila, o modo Limite passava a vez com eles
  // em 4/50 e 19/50 e os leads desabavam no segundo numero (35 dos 67 do Kevin foram pro 1859).
  const chipApi = { num: '55' + GUI, at: 'guilherme', api: true, wa_st: 'em_uso' };
  conta('chip de API com a linha CAIDA -> recebe (era o caso do 5847 e do 2248)', F._chipVivo(new Map(), chipApi, 'ax_guilherme') === true);
  conta('chip de API com a linha viva -> recebe', F._chipVivo(liveSet([['ax_guilherme_' + k8(GUI), '55' + GUI]]), chipApi, 'ax_guilherme') === true);
  apiMorto.add('15' + k8(GUI));
  conta('chip de API BANIDO -> nao recebe', F._chipVivo(new Map(), { ...chipApi, num: '5515' + k8(GUI) }, 'ax_guilherme') === false);
  apiMorto.clear();
}
{
  const chipAfl = { num: '55' + AFL, at: 'vend_afl', afl: 'afl_3d767329', wa_st: 'em_uso' };
  conta('chip de AFILIADO sem API (roleta) continua sem exigir conexao', F._chipVivo(liveSet([['ax_outro_' + k8(OUTRO), '55' + OUTRO]]), chipAfl, 'ax_vend_afl') === true);
  conta('chip de AFILIADO sem API continua distribuindo mesmo com o liveSet vazio', F._chipVivo(new Map(), chipAfl, 'ax_vend_afl') === true);
  const chipAflSc = { ...chipAfl, conn: 'sc' };
  conta('chip de afiliado no Sale Chat continua no _servConnOk (heartbeat dele aprova)', F._chipVivo(liveSet([['sc_55' + AFL, '55' + AFL]]), chipAflSc, 'ax_vend_afl') === true);
}

console.log('\nA ROLETA DE VERDADE (_resolvePresselSellers)\n');
{
  const p = { id: 'p1', vendedores: [{ at: 'guilherme' }] };
  const chips = [{ ...chipCasa }, { num: '55' + GUI, at: 'guilherme', api: true, wa_st: 'em_uso' }];
  const fora = new Set(['restrito', 'banido']);
  const numsF = ((F._resolvePresselSellers(p, chips, new Map(), new Set(), fora, new Set())[0] || {}).nums || []).map((n) => k8(n.num));
  conta('com tudo fechado a roleta entrega o numero do vendedor assim mesmo', numsF.length >= 1, JSON.stringify(numsF));
  const sZ = F._resolvePresselSellers(p, [{ ...chipCasa }], new Map(), new Set(), fora, new Set());
  conta('vendedor com um numero so, fechado: continua na roleta (antes ele saia)', sZ.length === 1, JSON.stringify(sZ.length));
  // O INTERRUPTOR E O QUE SOBROU MANDANDO. Palavras dele: "so se ele ficar desativado e que para".
  // Ele mora no VENDEDOR da pressel (v.off), indexado pelos 8 ultimos digitos, nao e parametro da
  // funcao: errei isso na primeira versao deste teste e ele acusou, que e o trabalho dele.
  const pOff = { id: 'p1', vendedores: [{ at: 'guilherme', off: { [k8(MIGRADO)]: true } }] };
  const comOff = ((F._resolvePresselSellers(pOff, [{ ...chipCasa }], new Map(), new Set(), fora, new Set())[0] || {}).nums || []).map((n) => k8(n.num));
  conta('numero DESLIGADO na pressel sai da roleta (o interruptor e quem manda agora)', comOff.length === 0, JSON.stringify(comOff));
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
  // 20/10/2026: o liveSet continua sendo montado certo (e o que a linha de cima prova, e ele ainda
  // decide pelo chip de AFILIADO com API), mas o chip da CASA nao o consulta mais.
  conta('... e o numero da casa fechado RECEBE assim mesmo (regra de 20/10)', F._chipVivo(ls, chipCasa, 'ax_guilherme') === true);
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
  // ATENCAO, PONTO EM ABERTO COM O BRUNO (20/10/2026): o app reportar `bloqueado` quer dizer que o
  // WhatsApp derrubou aquele numero, e clique pago indo pra la e dinheiro no lixo. Ate hoje isso
  // tirava o numero da roleta pelo liveSet; com a regra nova o chip da casa nao olha mais o liveSet,
  // entao ele passa a receber. O unico 'nao' que sobrou e o BANIDO NA META (_apiMorto), que e outra
  // fonte. Perguntei a ele se quer que `bloqueado` do app tambem valha como banido; enquanto nao
  // responder, fica como ele pediu: so o interruptor manda.
  conta('... e RECEBE assim mesmo (so o interruptor manda; ver o comentario acima)', F._chipVivo(ruim, chipCasa, 'ax_guilherme') === true);
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
