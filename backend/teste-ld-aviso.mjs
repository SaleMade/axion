// TESTE DO AVISO DOS 14 DIAS DO CELULAR PRINCIPAL (17/10/2026). Recorta o _ldOnlineAviso do worker.js e roda
// com banco e push falsos. Roda:  node teste-ld-aviso.mjs
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const i0 = src.indexOf('const LD_AVISO_DIAS');
const i1 = src.indexOf('// AGENDA: avisa quem marcou o retorno', i0);
if (i0 < 0 || i1 < 0) { console.error('NAO ACHEI o _ldOnlineAviso'); process.exit(1); }
let ok = 0; const falhas = [];
const vale = (n, c, d) => { if (c) { ok++; console.log('  OK      ' + n); } else { falhas.push(n); console.log('  FALHOU  ' + n + (d ? '  ->  ' + d : '')); } };

const mk = (horaBR) => {
  const cfg = {}; const pushes = [];
  const env = { DB: { prepare(sql) { let b = []; const st = {
    bind(...a) { b = a; return st; },
    async all() { return { results: [{ id: 'dir' }, { id: 'socio' }] }; },
    async run() { const [k, v] = b; if (cfg[k] === v) return { meta: { changes: 0 } }; cfg[k] = v; return { meta: { changes: 1 } }; },
  }; return st; } } };
  const fn = new Function('cfg', 'pushes', 'HORA', `
    const _agoraBR = () => { const d = new Date(); d.setUTCHours(HORA); return d; };
    const _brDay = () => '2026-10-17';
    const _readConfig = async (env, k) => cfg[k] === undefined ? null : cfg[k];
    const _ensureConfigTable = async () => {};
    const _wpParaPessoa = async (env, id, p) => { pushes.push({ id, ...p }); return 1; };
    const console = { log() {}, error() {} };
    ${src.slice(i0, i1)}
    return _ldOnlineAviso;`)(cfg, pushes, horaBR);
  return { cfg, pushes, env, aviso: fn };
};
const agora = Math.floor(Date.now() / 1000);
console.log('\nAVISO DOS 14 DIAS\n');
{
  const t = mk(10);
  t.cfg.ldplayer_online = JSON.stringify({ ts: agora - 600, celulares: [{ nk: '1592371970', nome: '37 - 15 99237-1970', ultimo: agora - 12 * 86400 }, { nk: '1599999999', nome: '40 - 15 99999-9999', ultimo: agora - 3 * 86400 }] });
  await t.aviso(t.env);
  vale('12 dias: avisa a direcao (2 pessoas) so desse celular', t.pushes.length === 2 && t.pushes.every((p) => /37 - 15 99237-1970/.test(p.title) && /12 dias/.test(p.body)), JSON.stringify(t.pushes));
  await t.aviso(t.env);
  vale('mesmo dia: nao repete', t.pushes.length === 2);
}
{
  const t = mk(10);
  t.cfg.ldplayer_online = JSON.stringify({ ts: agora - 600, celulares: [{ nk: 'a', nome: 'A', ultimo: agora - 15 * 86400 }] });
  await t.aviso(t.env);
  vale('15 dias: aviso de que passou de 14', t.pushes.length === 2 && /passou de 14/.test(t.pushes[0].title));
}
{
  const t = mk(10);
  t.cfg.ldplayer_online = JSON.stringify({ ts: agora - 3 * 86400, celulares: [{ nk: 'a', nome: 'A', ultimo: agora - 12 * 86400 }] });
  await t.aviso(t.env);
  vale('PC 3 dias sem noticia: avisa isso (e nao o celular, que pode ter aberto)', t.pushes.length === 2 && /PC dos celulares/.test(t.pushes[0].title));
}
{
  const t = mk(3);
  t.cfg.ldplayer_online = JSON.stringify({ ts: agora - 600, celulares: [{ nk: 'a', nome: 'A', ultimo: agora - 12 * 86400 }] });
  await t.aviso(t.env);
  vale('de madrugada: nao avisa', t.pushes.length === 0);
}
{
  const t = mk(10);
  await t.aviso(t.env);
  vale('vigia nunca rodou: nada', t.pushes.length === 0);
}
console.log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram.');
if (falhas.length) process.exit(1);
