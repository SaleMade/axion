// ALARME: O APP DO VENDEDOR PAROU DE REGISTRAR AS CONVERSAS (21/10/2026, a Barbara).
//
// Prova usada: funil disparado pelo app (swweb_funil) sem nenhuma mensagem de saida registrada pro
// mesmo telefone (wa_messages). Le o _alarmeCapturaParada DO PROPRIO worker.js e roda contra um D1 de
// mentira em cima do node:sqlite, com o SQL de verdade.
//
//   node teste-captura-parada.mjs
//   WORKER=<caminho> node teste-captura-parada.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const fonte = fs.readFileSync(process.env.WORKER || path.join(AQUI, 'worker.js'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
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

let ok = 0;
const falhas = [];
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome); }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')); }
};

const bloco = funcao('_alarmeCapturaParada');
conta('o worker tem o _alarmeCapturaParada', !!bloco);
if (!bloco) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1); }

let AGORA = 1792610000;
Date.now = () => AGORA * 1000;
const sq = new DatabaseSync(':memory:');
const limpa = (a) => a.map((x) => (x === undefined ? null : x));
const DB = {
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = limpa(a); return st; },
      async first() { return sq.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sq.prepare(sql).all(...args) }; },
      async run() { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return st;
  },
};
const env = { DB };
sq.exec('CREATE TABLE swweb_funil (fone TEXT, seq TEXT, at_id TEXT, nome TEXT, ts INTEGER, PRIMARY KEY (fone, seq))');
sq.exec('CREATE TABLE wa_messages (msg_id TEXT PRIMARY KEY, phone TEXT, instance TEXT, direction TEXT, ts INTEGER)');
sq.exec('CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, archived INTEGER, afiliado_id TEXT)');
sq.exec("INSERT INTO users VALUES ('dir','diretor',0,NULL),('barbara','vendedor',0,NULL),('gui','vendedor',0,NULL),('kevin','vendedor',0,NULL)");

const config = new Map();
const pushes = [];
const F = new Function('_readConfig', '_writeConfig', '_wpParaPessoa', 'let _capParadaIdx = false;\n' + bloco + '\nreturn { _alarmeCapturaParada };')(
  async (_e, k) => (config.has(k) ? config.get(k) : null),
  async (_e, k, v) => { config.set(k, v); },
  async (_e, id, p) => { pushes.push({ id, ...p }); });

let seq = 0, mid = 0;
const funil = (at, nome, fone, haSeg) => sq.prepare('INSERT INTO swweb_funil VALUES (?,?,?,?,?)').run(fone, 's' + (++seq), at, nome, AGORA - haSeg);
const saida = (fone, haSeg) => sq.prepare("INSERT INTO wa_messages VALUES (?,?,?,'out',?)").run('m' + (++mid), fone, 'ax_x', AGORA - haSeg);
const limpaTudo = () => { sq.exec('DELETE FROM swweb_funil; DELETE FROM wa_messages'); pushes.length = 0; config.clear(); };

console.log('\nO CASO DA BARBARA EM 21/10\n');
{
  for (let i = 0; i < 5; i++) funil('barbara', 'Barbara Marin', '5531999990' + i, 900 + i * 300);
  for (let i = 0; i < 5; i++) { funil('gui', 'Guilherme', '5515988880' + i, 900 + i * 300); saida('5515988880' + i, 900 + i * 300 - 20); }
  await F._alarmeCapturaParada(env);
  conta('a primeira conferencia so anota (pode ser piscada)', pushes.length === 0, String(pushes.length));
  AGORA += 300;
  await F._alarmeCapturaParada(env);
  const ids = [...new Set(pushes.map((p) => p.id))].sort().join(',');
  conta('funis sem nenhuma saida registrada: avisa a Barbara e a direcao', ids === 'barbara,dir', ids);
  conta('o Guilherme, com as saidas registradas, nao e avisado', !pushes.some((p) => /Guilherme/.test(p.title + p.body)), JSON.stringify(pushes.map((p) => p.title)));
  const pB = pushes.find((p) => p.id === 'barbara'), pD = pushes.find((p) => p.id === 'dir');
  conta('o aviso dela fala com ela e diz o que fazer', pB && pB.title === 'Seu SellWave Web parou de registrar' && /Voce mandou 5 funis/.test(pB.body) && /Feche o SellWave Web e abra de novo/.test(pB.body), pB && pB.body);
  conta('o da direcao diz de quem e', pD && pD.title === 'SellWave Web de Barbara parou de registrar' && /^Barbara mandou 5 funis/.test(pD.body), pD && pD.title);
  conta('sem travessao', !pushes.some((p) => /[–—]/.test(p.title + p.body)));
  pushes.length = 0; AGORA += 300;
  await F._alarmeCapturaParada(env);
  conta('cinco minutos depois nao repete', pushes.length === 0, String(pushes.length));
  AGORA += 3 * 3600;
  for (let i = 0; i < 4; i++) funil('barbara', 'Barbara Marin', '5531977770' + i, 900 + i * 300);
  await F._alarmeCapturaParada(env); AGORA += 300; await F._alarmeCapturaParada(env);
  conta('passadas 3 horas e ainda parado: avisa de novo', pushes.some((p) => p.id === 'barbara'), String(pushes.length));
}

console.log('\nO QUE NAO E CAPTURA PARADA\n');
limpaTudo();
{
  for (let i = 0; i < 5; i++) funil('gui', 'Guilherme', '5515966660' + i, 900 + i * 60);
  await F._alarmeCapturaParada(env);
  for (let i = 0; i < 5; i++) saida('5515966660' + i, 900 + i * 60 - 30);   // a captura chegou atrasada
  AGORA += 300; await F._alarmeCapturaParada(env);
  AGORA += 300; await F._alarmeCapturaParada(env);
  conta('piscada (parado numa volta, limpo na seguinte) nao avisa', pushes.length === 0, String(pushes.length));
}
limpaTudo();
{
  for (let i = 0; i < 4; i++) funil('kevin', 'Kevin Marques', '5515977770' + i, 900 + i * 300);
  saida('55159777700', 900 - 30);
  await F._alarmeCapturaParada(env);
  conta('uma saida registrada no meio de varios funis: nao avisa (o app registra)', pushes.length === 0, String(pushes.length));
}
limpaTudo();
{
  funil('barbara', 'Barbara Marin', '553199990001', 900); funil('barbara', 'Barbara Marin', '553199990002', 1200);
  await F._alarmeCapturaParada(env);
  conta('so dois funis: pouco pra afirmar, nao avisa', pushes.length === 0, String(pushes.length));
}
limpaTudo();
{
  for (let i = 0; i < 5; i++) funil('barbara', 'Barbara Marin', '5531999990' + i, 60 + i * 60);
  await F._alarmeCapturaParada(env);
  conta('funis de menos de 10 min ainda tem tempo de voltar: nao avisa', pushes.length === 0, String(pushes.length));
}
limpaTudo();
{
  for (let i = 0; i < 5; i++) { funil('barbara', 'Barbara Marin', '5531999990' + i, 900 + i * 300); saida('5531999990' + i, 900 + i * 300 + 1800); }
  await F._alarmeCapturaParada(env); AGORA += 300; await F._alarmeCapturaParada(env);
  conta('saida pro mesmo telefone mas muito antes do funil nao conta como registrada', pushes.some((p) => p.id === 'barbara'), String(pushes.length));
}
limpaTudo();
{
  // telefone com e sem 55/nono digito: casa pelos 8 finais
  for (let i = 0; i < 3; i++) { funil('gui', 'Guilherme', '55159888800' + i, 900 + i * 300); saida('159888800' + i, 900 + i * 300 - 10); }
  await F._alarmeCapturaParada(env);
  conta('casa o telefone pelos 8 finais (com e sem 55)', pushes.length === 0, String(pushes.length));
}

console.log('\nA LIGACAO NO CRON\n');
conta('roda na manutencao, logo depois do arquivo de leads',
  /_arqCron\(env\);[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*try \{ await _alarmeCapturaParada\(env\); \}/.test(fonte));

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) process.exit(1);
