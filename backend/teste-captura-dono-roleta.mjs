// CAPTURA DO SELLWAVE WEB: DONO DO NUMERO E ROLETA (17/10/2026). Confere os dois consertos do worker
// pedidos pelo Bruno ("a captura tem que funcionar 100%, pode ser so com o WhatsApp aberto"):
//
//  1) O lead/venda capturado pelo app fica com o DONO DO NUMERO na Contingencia, nao com o login de
//     quem abriu o numero (diretor/socio abrindo numero de vendedor carimbava tudo pra si; aconteceu no
//     ..0653). O Sale Chat, que nao manda a flag, continua igual. Evento de protocolo nao grava
//     wa_attrib.
//  2) Chip da CASA sem API so entra na roleta com o app aberto (sai do _modoRoleta); o chip de
//     AFILIADO continua distribuindo sem captura.
//
// Le as funcoes DO PROPRIO worker.js (recorta o trecho e avalia com dubles so nas bordas), igual ao
// teste-mesma-pessoa.mjs: copia da logica testaria a copia.
//
//   node teste-captura-dono-roleta.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const fonte = fs.readFileSync(path.join(AQUI, 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
const recorta = (de, ate) => {
  const i = fonte.indexOf(de);
  const f = fonte.indexOf(ate, i + de.length);
  if (i < 0 || f < 0) { console.log('  ERRO  nao achei o trecho ' + de); process.exit(1); }
  return fonte.slice(i, f);
};

let ok = 0;
const falhas = [];
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome); }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')); }
};

// ─────────────────────────────── 1) _modoRoleta ───────────────────────────────
console.log('ROLETA: QUEM PODE RECEBER SEM CAPTURA\n');
const linhaModo = fonte.split('\n').find((l) => l.startsWith('function _modoRoleta('));
const _modoRoleta = new Function(linhaModo + '\nreturn _modoRoleta;')();
conta('chip da CASA sem API exige captura (nao e roleta)', _modoRoleta({ num: '15974060653', at: 'dir' }) === false);
conta('chip da casa sem API com conn vazio (o caso do ..0653) exige captura', _modoRoleta({ num: '15974060653', at: 'dir', conn: '' }) === false);
conta('chip de AFILIADO sem API continua roleta (distribui sem captura)', _modoRoleta({ num: '11999990000', at: 'x', afl: 'afl_3d767329' }) === true);
conta('chip de afiliado com conn sc exige captura', _modoRoleta({ num: '11999990000', afl: 'afl_3d767329', conn: 'sc' }) === false);
conta('chip de API nunca e roleta (casa)', _modoRoleta({ num: '1', api: true }) === false);
conta('chip de API nunca e roleta (afiliado)', _modoRoleta({ num: '1', api: true, afl: 'afl_x' }) === false);
conta('sem chip nao e roleta', _modoRoleta(null) === false);

// ─────────────────────────────── 2) dono da captura ───────────────────────────────
console.log('\nCAPTURA: DE QUEM E O LEAD\n');
const blocoIngest = recorta('async function handleSalechatIngest(', '\n// ═══');
const blocoInst = recorta('function _instComNumero(', '\n// Resolve o número OFICIAL');
const blocoNaoMsg = recorta('const _WA_NAO_MSG = new Set([', '\n// LEAD:');

function montaIngest() {
  const chamadas = { lead: [], attrib: [], log: [], venda: [] };
  const DONOS = { '5515974060653': { at_id: 'dir', instance: 'ax_dir' }, '5515900005555': { at_id: 'ccol_5', instance: 'ax_ccol_5' } };   // dono do NUMERO na Contingencia (o 2o esta numa COLUNA)
  const INSTALACOES = { 'swweb:socio_x4dy6d': { at_id: 'socio_x4dy6d', instance: 'ax_socio_x4dy6d' }, 'sc_vendedor': { at_id: 'atendente_aaa', instance: 'ax_atendente_aaa' } };
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              run: async () => { if (/INSERT INTO wa_attrib/.test(sql)) chamadas.attrib.push(args); return {}; },
              first: async () => null, all: async () => ({ results: [] }),
            };
          },
          run: async () => ({}),
        };
      },
    },
  };
  const deps = {
    _scIngestToken: async () => 'tok',
    _scEnsureTables: async () => {},
    _waCaptureSource: async () => 'sc',
    resolveInstall: async (_env, id) => INSTALACOES[id] || null,
    resolveOwner: async (_env, num) => DONOS[String(num)] || null,
    _waLogMsg: async (_env, m) => { chamadas.log.push(m); },
    _waDetectSale: async (_env, inst) => { chamadas.venda.push(inst); return {}; },
    _waLeadCapture: async (_env, inst) => { chamadas.lead.push(inst); },
    _ehUsuarioAtivo: async (_env, at) => !/^ccol_/.test(String(at)),
    _scStoreMedia: async () => '',
    json: (obj) => obj,
  };
  const nomes = Object.keys(deps);
  const fabrica = new Function(...nomes, 'let _attribTablesOk = true;\n' + blocoNaoMsg + '\n' + blocoInst + '\n' + blocoIngest + '\nreturn handleSalechatIngest;');
  const handleSalechatIngest = fabrica(...nomes.map((n) => deps[n]));
  const chama = (body) => handleSalechatIngest({ json: async () => body }, env, 'tok');
  return { chama, chamadas };
}
const evLead = { msgId: 'm1', selfNumber: '5515974060653', phone: '5511988887777', type: 'chat', body: 'Codigo de desconto "AB12C"', ts: Math.floor(Date.now() / 1000) };

{
  const { chama, chamadas } = montaIngest();
  await chama({ installId: 'swweb:socio_x4dy6d', donoPorNumero: true, events: [evLead] });
  conta('SellWave Web: socio abrindo o numero do dir -> o lead e do DIR', chamadas.lead[0] === 'ax_dir_74060653', JSON.stringify(chamadas.lead));
  conta('SellWave Web: o wa_attrib tambem vai pro dono do numero', chamadas.attrib.length === 1 && chamadas.attrib[0][1] === 'ax_dir_74060653', JSON.stringify(chamadas.attrib));
  conta('SellWave Web: a bolha do inbox vai pra instancia do dono', chamadas.log[0] && chamadas.log[0].instance === 'ax_dir_74060653');
}
{
  const { chama, chamadas } = montaIngest();
  await chama({ installId: 'swweb:socio_x4dy6d', donoPorNumero: true, events: [{ ...evLead, selfNumber: '5511900001111' }] });
  conta('SellWave Web: numero SEM dono na Contingencia -> cai no login (nao some)', chamadas.lead[0] === 'ax_socio_x4dy6d_00001111', JSON.stringify(chamadas.lead));
}
{
  const { chama, chamadas } = montaIngest();
  await chama({ installId: 'swweb:socio_x4dy6d', donoPorNumero: true, events: [{ ...evLead, selfNumber: '5515900005555' }] });
  conta('SellWave Web: numero numa COLUNA da Contingencia (ccol_5) -> fica o login, nunca a coluna', chamadas.lead[0] === 'ax_socio_x4dy6d_00005555', JSON.stringify(chamadas.lead));
}
{
  const { chama, chamadas } = montaIngest();
  await chama({ installId: 'sc_vendedor', events: [evLead] });
  conta('Sale Chat (sem a flag) continua com a instalacao primeiro, como sempre foi', chamadas.lead[0] === 'ax_atendente_aaa_74060653', JSON.stringify(chamadas.lead));
}
{
  const { chama, chamadas } = montaIngest();
  await chama({ installId: 'swweb:socio_x4dy6d', donoPorNumero: true, events: [{ ...evLead, msgId: 'm2', type: 'e2e_notification', body: '' }] });
  conta('evento de protocolo nao grava wa_attrib', chamadas.attrib.length === 0, JSON.stringify(chamadas.attrib));
}
{
  const { chama, chamadas } = montaIngest();
  await chama({ installId: 'swweb:socio_x4dy6d', donoPorNumero: true, events: [{ ...evLead, msgId: 'm3', type: 'ciphertext', body: '' }] });
  conta('ciphertext (mensagem real ainda cifrada) continua gravando wa_attrib e indo pro lead', chamadas.attrib.length === 1 && chamadas.lead.length === 1);
}
{
  const { chama, chamadas } = montaIngest();
  await chama({ installId: 'swweb:socio_x4dy6d', donoPorNumero: true, events: [{ ...evLead, msgId: 'm4', velha: true }] });
  conta('mensagem velha continua sem gravar wa_attrib', chamadas.attrib.length === 0);
}

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) process.exit(1);
