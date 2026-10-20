// LEAD ATRASADO COM CODIGO (20/10/2026). Recorta a guarda de idade do _waLeadCapture DO PROPRIO worker.js
// e roda com um D1 de mentira (node:sqlite). Confere: mensagem velha SEM codigo continua descartada; velha
// COM codigo de um clique nao reivindicado das ultimas 24 h passa; codigo ja usado, clique de mais de 24 h
// ou mensagem de mais de 24 h continuam descartados.
//   node teste-lead-atrasado.mjs
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const fonte = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const i0 = fonte.indexOf('    const _ts = Number(msgTs) || 0;');
const i1 = fonte.indexOf('    if (await _botEhDoBot(', i0);
if (i0 < 0 || i1 < 0) { console.log('NAO ACHEI a guarda'); process.exit(1); }
const guarda = fonte.slice(i0, i1);
const sq = new DatabaseSync(':memory:');
sq.exec('CREATE TABLE tt_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, claimed INTEGER DEFAULT 0, ts INTEGER)');
const st = (sql, a = []) => ({ bind: (...b) => st(sql, b), first: async () => { const r = sq.prepare(sql).get(...a); return r ? { ...r } : null; } });
const env = { DB: { prepare: (sql) => st(sql) } };
const roda = new Function('env', 'body', 'msgTs', 'maxIdade', 'selfNum', 'console', 'return (async () => {' + guarda + '; return "passou"; })()');
const agora = Math.floor(Date.now() / 1000);
sq.prepare('INSERT INTO tt_pending (code, claimed, ts) VALUES (?,?,?)').run('ABC123', 0, agora - 5 * 3600);
sq.prepare('INSERT INTO tt_pending (code, claimed, ts) VALUES (?,?,?)').run('USADO1', 1, agora - 3600);
sq.prepare('INSERT INTO tt_pending (code, claimed, ts) VALUES (?,?,?)').run('VELHO1', 0, agora - 30 * 3600);
let ok = 0, mau = 0;
const t = async (nome, esperado, body, idade) => {
  const logs = [];
  const r = await roda(env, body, agora - idade, 1800, '5515999990000', { log: (x) => logs.push(x) });
  const deu = r === 'passou' ? 'passou' : 'descartou';
  if (deu === esperado) { ok++; console.log('  ok    ' + nome); } else { mau++; console.log('  ERRO  ' + nome + ' (deu ' + deu + ')'); }
};
const msg = (c) => 'Olá! Gostaria de saber mais sobre o tratamento. Código de desconto "' + c + '"!';
await t('mensagem nova sem codigo passa (nada mudou)', 'passou', 'oi', 60);
await t('velha sem codigo continua descartada (historico ao reconectar)', 'descartou', 'oi, tudo bem?', 4 * 3600);
await t('velha COM codigo de clique nao usado das ultimas 24 h passa', 'passou', msg('ABC123'), 4 * 3600);
await t('velha com codigo que JA virou lead e descartada', 'descartou', msg('USADO1'), 4 * 3600);
await t('velha com codigo de clique de mais de 24 h e descartada', 'descartou', msg('VELHO1'), 4 * 3600);
await t('mensagem de mais de 24 h e descartada mesmo com codigo bom', 'descartou', msg('ABC123'), 25 * 3600);
await t('codigo que nao existe e descartado', 'descartou', msg('ZZZ999'), 4 * 3600);
console.log('\n' + ok + ' de ' + (ok + mau));
process.exit(mau ? 1 : 0);
