// LOGOUT COM MOTIVO DO WHATSAPP (20/10/2026). Recorta do PROPRIO worker.js o trecho do POST /api/swweb/conexao
// que reclassifica o estado pela queda e confere: account_locked vira bloqueado com aviso; outro motivo vira
// caiu com aviso; queda velha ou numero ja pronto nao mudam nada.
//   node teste-logout-motivo.mjs
import fs from 'node:fs';
const fonte = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const i0 = fonte.indexOf("    let st = String((b && b.st) || '').slice(0, 20);");
const i1 = fonte.indexOf('    await _scEnsureTables(env);', i0);
if (i0 < 0 || i1 < 0) { console.log('NAO ACHEI o trecho'); process.exit(1); }
const trecho = fonte.slice(i0, i1).replace("if (!st) return err('Falta o estado');", '');
const roda = new Function('b', trecho + '; return { st, espontaneo };');
let ok = 0, mau = 0;
const t = (nome, b, st, esp) => {
  const r = roda(b);
  if (r.st === st && r.espontaneo === esp) { ok++; console.log('  ok    ' + nome); } else { mau++; console.log('  ERRO  ' + nome + ' -> ' + JSON.stringify(r)); }
};
const agora = Date.now();
t('account_locked recente vira bloqueado com aviso (o caso do 1970)', { st: 'sincronizando', espontaneo: false, queda: { modo: 'LOGOUT_REASON', motivo: 'account_locked', ts: agora - 5000 } }, 'bloqueado', 1);
t('outro motivo de logout vira caiu com aviso', { st: 'qr', espontaneo: false, queda: { modo: 'LOGOUT_REASON', motivo: 'unknown', ts: agora - 5000 } }, 'caiu', 1);
t('queda velha (2 h) nao muda nada', { st: 'sincronizando', espontaneo: false, queda: { modo: 'LOGOUT_REASON', motivo: 'account_locked', ts: agora - 7200000 } }, 'sincronizando', 0);
t('numero ja pronto com o motivo antigo continua pronto', { st: 'pronto', espontaneo: false, queda: { modo: 'LOGOUT_REASON', motivo: 'account_locked', ts: agora - 5000 } }, 'pronto', 0);
t('queda de outro tipo (REQUIRE_AUTH) nao muda nada', { st: 'qr', espontaneo: false, queda: { modo: 'REQUIRE_AUTH', motivo: '', ts: agora - 5000 } }, 'qr', 0);
t('sem queda nao muda nada', { st: 'pronto', espontaneo: false, queda: null }, 'pronto', 0);
console.log('\n' + ok + ' de ' + (ok + mau));
process.exit(mau ? 1 : 0);
