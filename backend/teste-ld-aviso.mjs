// TESTE DO AVISO DOS 14 DIAS DO CELULAR PRINCIPAL (17/10/2026; de 12 em 12 horas desde 02/11/2026). Recorta o
// _ldOnlineAviso do worker.js e roda com banco e push falsos. Roda:  node teste-ld-aviso.mjs
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const i0 = src.indexOf('const LD_AVISO_DIAS');
const i1 = src.indexOf('// AGENDA: avisa quem marcou o retorno', i0);
if (i0 < 0 || i1 < 0) { console.error('NAO ACHEI o _ldOnlineAviso'); process.exit(1); }
let ok = 0; const falhas = [];
const vale = (n, c, d) => { if (c) { ok++; console.log('  OK      ' + n); } else { falhas.push(n); console.log('  FALHOU  ' + n + (d ? '  ->  ' + d : '')); } };

// O relogio do teste anda sozinho: t.pula(horas) adianta o Date.now que o worker enxerga.
const real = Date.now;
let desvio = 0;
Date.now = () => real() + desvio;

const mk = (horaBR) => {
  const cfg = {}; const pushes = [];
  // Banco falso que entende as duas escritas que o aviso faz: o trinco condicional (ld_lembrete) e nada mais.
  const env = { DB: { prepare(sql) { let b = []; const st = {
    bind(...a) { b = a; return st; },
    async all() { return { results: [{ id: 'dir' }, { id: 'socio' }] }; },
    async run() {
      if (/ld_lembrete/.test(sql)) {
        const [v, , limite] = b;
        if (cfg.ld_lembrete !== undefined && Number(cfg.ld_lembrete) > limite) return { meta: { changes: 0 } };
        cfg.ld_lembrete = v; return { meta: { changes: 1 } };
      }
      throw new Error('escrita inesperada: ' + sql);
    },
  }; return st; } } };
  const t = { cfg, pushes, env, hora: horaBR };
  const fn = new Function('cfg', 'pushes', 't', `
    const _agoraBR = () => { const d = new Date(); d.setUTCHours(t.hora); return d; };
    const _readConfig = async (env, k) => cfg[k] === undefined ? null : cfg[k];
    const _ensureConfigTable = async () => {};
    const _wpParaPessoa = async (env, id, p) => { pushes.push({ id, ...p }); return 1; };
    const console = { log() {}, error() {} };
    ${src.slice(i0, i1)}
    return _ldOnlineAviso;`)(cfg, pushes, t);
  t.aviso = () => fn(env);
  t.pula = (horas) => { desvio += horas * 3600000; };
  return t;
};
const agora = () => Math.floor(Date.now() / 1000);
const cel = (nome, dias) => ({ nk: nome, nome, ultimo: agora() - Math.round(dias * 86400) });
const estado = (celulares, semNoticiaS = 600) => JSON.stringify({ ts: agora() - semNoticiaS, celulares });

console.log('\nAVISO DOS 14 DIAS\n');
{
  desvio = 0;
  const t = mk(10);
  t.cfg.ldplayer_online = estado([cel('37 - 15 99237-1970', 12.2), cel('40 - 15 99999-9999', 3)]);
  await t.aviso();
  vale('12 dias: avisa a direcao (2 pessoas) so desse celular, com o nome inteiro', t.pushes.length === 2 && t.pushes.every((p) => /37 - 15 99237-1970/.test(p.title) && /12 dias/.test(p.body)), JSON.stringify(t.pushes));
  vale('a tag e uma so (o aviso novo substitui o velho no celular)', t.pushes.every((p) => p.tag === 'ld-aviso'));
  await t.aviso();
  vale('na batida seguinte: nao repete', t.pushes.length === 2);
  t.pula(6); await t.aviso();
  vale('6 horas depois: ainda nao repete', t.pushes.length === 2);
  t.pula(6); await t.aviso();
  vale('12 horas depois e sem abrir: avisa de novo', t.pushes.length === 4, String(t.pushes.length));
  t.pula(12); t.hora = 3; await t.aviso();
  vale('o proximo de 12 horas caiu de madrugada: espera', t.pushes.length === 4);
  t.hora = 8; await t.aviso();
  vale('as 8 da manha sai o que esperou', t.pushes.length === 6, String(t.pushes.length));
  t.cfg.ldplayer_online = estado([cel('37 - 15 99237-1970', 0.01), cel('40 - 15 99999-9999', 3)]);
  t.pula(12); t.hora = 20; await t.aviso();
  vale('abriu o celular: para de avisar', t.pushes.length === 6);
}
{
  desvio = 0;
  const t = mk(10);
  t.cfg.ldplayer_online = estado([cel('A', 15)]);
  await t.aviso();
  vale('15 dias: aviso de que passou de 14', t.pushes.length === 2 && /passou de 14/.test(t.pushes[0].title));
}
{
  desvio = 0;
  const t = mk(10);
  t.cfg.ldplayer_online = estado([
    cel('63 - 15 99187-2193', 11.9), cel('53 - 11 97251-8066', 13.7), cel('56 - 15 99918-7219', 13.5),
    cel('61 - 15 99241-8925', 12.8), cel('46 - 15 97407-6200', 3.1), cel('54 - 31 97362-3697', 13.5),
  ]);
  await t.aviso();
  const p = t.pushes[0] || {};
  vale('varios celulares: UM aviso por pessoa, nao um por celular', t.pushes.length === 2, String(t.pushes.length));
  vale('titulo diz quantos', p.title === 'Abra 5 celulares', p.title);
  vale('corpo agrupa por dias, do mais atrasado pro menos, so com o numero curto', /^53, 54 e 56 \(13 dias\); 61 \(12 dias\); 63 \(11 dias\)\. Com 14, o WhatsApp desconecta/.test(p.body || ''), p.body);
  vale('celular em dia fica de fora', !/46/.test(p.body || ''));
}
{
  desvio = 0;
  const t = mk(10);
  t.cfg.ldplayer_online = estado([cel('53 - 11 97251-8066', 14.2), cel('61 - 15 99241-8925', 12.8)]);
  await t.aviso();
  vale('um ja passou de 14: o titulo fala disso', (t.pushes[0] || {}).title === 'Abra 2 celulares: 1 já passou de 14 dias', (t.pushes[0] || {}).title);
  vale('e o corpo diz que pode ter desconectado', /pode ter desconectado/.test((t.pushes[0] || {}).body || ''));
}
{
  desvio = 0;
  const t = mk(10);
  t.cfg.ldplayer_online = estado([cel('A', 12)], 3 * 86400);
  await t.aviso();
  vale('PC 3 dias sem noticia: avisa isso (e nao o celular, que pode ter aberto)', t.pushes.length === 2 && /PC dos celulares/.test(t.pushes[0].title));
}
for (const [h, sai] of [[3, false], [7, false], [8, true], [21, true], [22, false]]) {
  desvio = 0;
  const t = mk(h);
  t.cfg.ldplayer_online = estado([cel('A', 12)]);
  await t.aviso();
  vale('as ' + h + 'h: ' + (sai ? 'avisa' : 'nao avisa'), (t.pushes.length > 0) === sai);
}
{
  desvio = 0;
  const t = mk(10);
  t.cfg.ld_aviso_A = '2026-11-02';   // trinco do formato antigo (um por dia) nao segura o novo
  t.cfg.ldplayer_online = estado([cel('A', 12)]);
  await t.aviso();
  vale('trinco antigo do dia nao impede o primeiro aviso novo', t.pushes.length === 2);
}
{
  desvio = 0;
  const t = mk(10);
  await t.aviso();
  vale('vigia nunca rodou: nada', t.pushes.length === 0);
}
Date.now = real;
console.log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram.');
if (falhas.length) process.exit(1);
