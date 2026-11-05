// O QUE O VENDEDOR CRIA NO PAINEL DO SELLWAVE WEB (05/11/2026), NA ROTA DE VERDADE. Roda o worker
// inteiro (bundle do wrangler) contra um D1 de mentira e prova:
//   1) criar texto, foto e funil, e que eles voltam no GET /api/swweb/roteiro, EM CIMA do oficial;
//   2) "so pra mim" nao aparece pra outro vendedor; "pra todos" aparece, com o nome de quem criou;
//   3) "pra todos" nao atravessa operacao (casa x afiliado) nem cargo (vendedor x cobrador);
//   4) so o dono (ou a direcao da operacao) muda e apaga; os outros so escondem pra si;
//   5) esconder e por pessoa e vale pra item oficial tambem;
//   6) o que vem da tela e limpo (espera do passo entre 0 e 120, chave de arquivo so do R2 nosso);
//   7) o "ver como" da direcao nao grava nada.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-swweb-itens.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-swweb-itens.mjs <bundle>/worker.js'); process.exit(2); }
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
console.log = () => {};

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

const agoraS = Math.floor(Date.now() / 1000);
const exp = agoraS + 86400;
// id, nome, cargo, afiliado_id
const usuarios = [
  ['dir', 'Bruno Diretor', 'diretor', null],
  ['kev', 'Kevin Marques', 'atendente', null],
  ['gui', 'Guilherme Lima', 'atendente', null],
  ['hay', 'Haynan Souza', 'cobrador', null],
  ['gio', 'Giovane Afiliado', 'afiliado', 'afl_1'],
  ['tha', 'Thariky do Giovane', 'atendente', 'afl_1'],
  ['sol', 'Afiliado Solto', 'afiliado', null],
  ['sol2', 'Outro Solto', 'afiliado', null],
];
for (const [id, nome, role, afl] of usuarios) {
  sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,afiliado_id) VALUES (?,?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role, afl);
}
const TK = {};
usuarios.forEach(([id], i) => { TK[id] = String.fromCharCode(97 + i).repeat(64); sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[id], id, exp); });

const estado = {
  salechatPub: {
    messages: [{ id: 'm1', label: 'H - 01 Abertura', text: 'Oi!', grp: 'Homem' }],
    media: [{ id: 'a1', kind: 'audio', label: 'H - 02 Explicacao', key: 'm/aaa.ogg', mime: 'audio/ogg', grp: 'Homem' }],
    sequences: [{ id: 'seq1', label: 'H - Etapa 1', items: [{ id: 'a1', sim: 3 }, { id: 'm1', sim: 5 }], grp: 'Homem' }],
  },
  salechatCobPub: { messages: [{ id: 'c1', label: 'Rastreio', text: 'Seu pedido saiu' }], media: [], sequences: [] },
};
sq.prepare('INSERT INTO dashboard_state (id, data, version, updated_at) VALUES (1, ?, 1, ?)').run(JSON.stringify(estado), agoraS);

// O bundle importa de 'cloudflare:workers', que o Node nao carrega: vira classe vazia (igual ao
// teste-cobranca-rota).
const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-itens.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const chama = async (tk, path, body) => {
  const h = {};
  if (tk) h.authorization = 'Bearer ' + tk;
  if (body) h['content-type'] = 'application/json';
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.clone().json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
const roteiro = async (tk, como) => (await chama(tk, '/api/swweb/roteiro' + (como ? '?como=' + como : ''))).d;
const ids = (lista) => (lista || []).map((x) => x.id);

_log('\nCRIAR E LER DE VOLTA\n');
let r = await chama(TK.kev, '/api/swweb/item', { tipo: 'text', escopo: 'eu', label: 'Meu bom dia', text: 'Bom dia, *tudo bem*?' });
vale('o vendedor cria uma mensagem so pra ele', r.st === 200 && r.d.ok && /^sw/.test(r.d.id), r.st + ' ' + JSON.stringify(r.d));
const T1 = r.d.id;
r = await chama(TK.kev, '/api/swweb/item', { tipo: 'image', escopo: 'todos', label: 'Tabela de precos', key: 'm/xyz123.png', mime: 'image/png', caption: 'olha so' });
vale('e uma foto pra todos', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d));
const F1 = r.d.id;
r = await chama(TK.kev, '/api/swweb/item', { tipo: 'funil', escopo: 'eu', label: 'Meu fechamento', passos: [{ id: 'a1', espera: null }, { id: T1, espera: 30 }, { id: F1, espera: 999 }, { id: '<script>', espera: 5 }] });
vale('e um funil com tempo de espera por passo', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d));
const S1 = r.d.id;

let ro = await roteiro(TK.kev);
vale('o roteiro dele traz a mensagem dele', ids(ro.messages).includes(T1), JSON.stringify(ids(ro.messages)));
vale('EM CIMA da oficial', ids(ro.messages)[0] === T1 && ids(ro.messages).includes('m1'), JSON.stringify(ids(ro.messages)));
const mT1 = (ro.messages || []).find((x) => x.id === T1);
vale('com o texto inteiro e no grupo "Meus itens"', mT1 && mT1.text === 'Bom dia, *tudo bem*?' && mT1.grp === 'Meus itens', JSON.stringify(mT1));
vale('marcada como dele e editavel', mT1 && mT1.sw && mT1.sw.meu === true && mT1.sw.pode === true && mT1.sw.escopo === 'eu', JSON.stringify(mT1 && mT1.sw));
const mF1 = (ro.media || []).find((x) => x.id === F1);
vale('a foto vem como midia, com chave, legenda e tipo', mF1 && mF1.kind === 'image' && mF1.key === 'm/xyz123.png' && mF1.caption === 'olha so', JSON.stringify(mF1));
const sS1 = (ro.sequences || []).find((x) => x.id === S1);
vale('o funil vem com os passos', sS1 && sS1.items.length === 3, JSON.stringify(sS1 && sS1.items));
vale('passo sem tempo fica automatico (null)', sS1 && sS1.items[0].espera === null, JSON.stringify(sS1 && sS1.items[0]));
vale('a espera de 30 s fica', sS1 && sS1.items[1].espera === 30, JSON.stringify(sS1 && sS1.items[1]));
vale('espera absurda vira o teto de 120 s', sS1 && sS1.items[2].espera === 120, JSON.stringify(sS1 && sS1.items[2]));
vale('passo com id invalido cai fora', sS1 && !sS1.items.some((p) => p.id === '<script>'), JSON.stringify(sS1 && sS1.items));
vale('o funil oficial continua la', ids(ro.sequences).includes('seq1'), JSON.stringify(ids(ro.sequences)));
vale('a lista de escondidos nasce vazia', Array.isArray(ro.ocultos) && ro.ocultos.length === 0, JSON.stringify(ro.ocultos));

_log('\nSO PRA MIM x PRA TODOS\n');
ro = await roteiro(TK.gui);
vale('outro vendedor NAO ve a mensagem "so pra mim" do Kevin', !ids(ro.messages).includes(T1), JSON.stringify(ids(ro.messages)));
vale('nem o funil "so pra mim"', !ids(ro.sequences).includes(S1), JSON.stringify(ids(ro.sequences)));
const gF1 = (ro.media || []).find((x) => x.id === F1);
vale('mas ve a foto "pra todos"', !!gF1, JSON.stringify(ids(ro.media)));
vale('no grupo "Da equipe", com o nome de quem criou', gF1 && gF1.grp === 'Da equipe' && /Kevin/.test(gF1.sw.de), JSON.stringify(gF1));
vale('e sem poder editar', gF1 && gF1.sw.meu === false && gF1.sw.pode === false, JSON.stringify(gF1 && gF1.sw));
ro = await roteiro(TK.dir);
const dF1 = (ro.media || []).find((x) => x.id === F1);
vale('a direcao da casa ve a "pra todos" e pode editar', dF1 && dF1.sw.pode === true, JSON.stringify(dF1 && dF1.sw));

_log('\nNAO ATRAVESSA OPERACAO NEM CARGO\n');
ro = await roteiro(TK.tha);
vale('a equipe do afiliado NAO ve o "pra todos" da casa', !ids(ro.media).includes(F1), JSON.stringify(ids(ro.media)));
r = await chama(TK.tha, '/api/swweb/item', { tipo: 'text', escopo: 'todos', label: 'Do Thariky', text: 'oi do afiliado' });
const TA = r.d.id;
ro = await roteiro(TK.gio);
vale('o afiliado ve o "pra todos" da equipe dele', ids(ro.messages).includes(TA), JSON.stringify(ids(ro.messages)));
vale('e o dono do mundo pode editar o item da equipe dele', ((ro.messages || []).find((x) => x.id === TA) || {}).sw?.pode === true, '');
ro = await roteiro(TK.kev);
vale('e a casa NAO ve o do afiliado', !ids(ro.messages).includes(TA), JSON.stringify(ids(ro.messages)));
r = await chama(TK.dir, '/api/swweb/item', { id: TA, label: 'mexi', text: 'mexi' });
vale('a direcao da casa NAO mexe no item do afiliado', r.st === 403, r.st + ' ' + JSON.stringify(r.d));
ro = await roteiro(TK.hay);
vale('o cobrador NAO ve o "pra todos" de vendedor', !ids(ro.media).includes(F1) && ids(ro.messages).includes('c1'), JSON.stringify({ m: ids(ro.messages), md: ids(ro.media) }));
r = await chama(TK.hay, '/api/swweb/item', { tipo: 'text', escopo: 'todos', label: 'Cobrar', text: 'Seu boleto vence hoje' });
const TC = r.d.id;
ro = await roteiro(TK.gui);
vale('e o vendedor NAO ve o "pra todos" de cobrador', !ids(ro.messages).includes(TC), JSON.stringify(ids(ro.messages)));
r = await chama(TK.sol, '/api/swweb/item', { tipo: 'text', escopo: 'todos', label: 'Solto', text: 'oi' });
ro = await roteiro(TK.sol2);
vale('afiliado sem vinculo nao tem equipe: o "pra todos" dele nao vaza pra outro solto', !ids(ro.messages).includes(r.d.id), JSON.stringify(ids(ro.messages)));

_log('\nQUEM MUDA E QUEM APAGA\n');
r = await chama(TK.gui, '/api/swweb/item', { id: F1, label: 'roubei', key: 'm/xyz123.png' });
vale('outro vendedor NAO muda a foto do Kevin', r.st === 403, r.st + ' ' + JSON.stringify(r.d));
r = await chama(TK.gui, '/api/swweb/item/apagar', { id: F1 });
vale('nem apaga', r.st === 403, r.st + ' ' + JSON.stringify(r.d));
r = await chama(TK.kev, '/api/swweb/item', { id: T1, escopo: 'todos', label: 'Bom dia 2', text: 'Bom dia de novo' });
vale('o dono muda o texto e passa pra todos', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d));
ro = await roteiro(TK.gui);
const gT1 = (ro.messages || []).find((x) => x.id === T1);
vale('e o outro vendedor passa a ver, com o texto novo', gT1 && gT1.text === 'Bom dia de novo' && gT1.label === 'Bom dia 2', JSON.stringify(gT1));
r = await chama(TK.kev, '/api/swweb/item', { id: T1, tipo: 'image', label: 'x', text: '' });
vale('editar nao troca o tipo (texto vazio e recusado como texto)', r.st === 400 && /mensagem/i.test(r.d.error || ''), r.st + ' ' + JSON.stringify(r.d));
r = await chama(TK.kev, '/api/swweb/item/apagar', { id: T1 });
vale('o dono apaga', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d));
ro = await roteiro(TK.gui);
vale('e some da lista de todo mundo', !ids(ro.messages).includes(T1), JSON.stringify(ids(ro.messages)));
r = await chama(TK.dir, '/api/swweb/item/apagar', { id: F1 });
vale('a direcao da casa apaga o "pra todos" de um vendedor', r.st === 200 && r.d.ok, r.st + ' ' + JSON.stringify(r.d));

_log('\nESCONDER E POR PESSOA\n');
r = await chama(TK.gui, '/api/swweb/ocultar', { id: 'a1', oculto: true });
vale('o vendedor esconde um audio oficial', r.st === 200 && (r.d.ocultos || []).includes('a1'), r.st + ' ' + JSON.stringify(r.d));
await chama(TK.gui, '/api/swweb/ocultar', { id: 'seq1', oculto: true });
ro = await roteiro(TK.gui);
vale('a lista de escondidos dele volta no roteiro', (ro.ocultos || []).includes('a1') && (ro.ocultos || []).includes('seq1'), JSON.stringify(ro.ocultos));
vale('o item escondido CONTINUA no roteiro (o funil ainda usa ele)', ids(ro.media).includes('a1'), JSON.stringify(ids(ro.media)));
ro = await roteiro(TK.kev);
vale('e pro outro vendedor nada esta escondido', (ro.ocultos || []).length === 0, JSON.stringify(ro.ocultos));
r = await chama(TK.gui, '/api/swweb/ocultar', { id: 'a1', oculto: false });
vale('mostrar de novo tira da lista', r.st === 200 && !(r.d.ocultos || []).includes('a1') && (r.d.ocultos || []).includes('seq1'), JSON.stringify(r.d.ocultos));
r = await chama(TK.gui, '/api/swweb/ocultar', { id: 'a"><img', oculto: true });
vale('id estranho e recusado', r.st === 400, r.st + ' ' + JSON.stringify(r.d));

_log('\nO QUE VEM DA TELA E LIMPO\n');
r = await chama(TK.kev, '/api/swweb/item', { tipo: 'audio', escopo: 'eu', label: 'audio', key: 'https://outro.site/x.ogg' });
vale('arquivo de fora do nosso R2 e recusado', r.st === 400, r.st + ' ' + JSON.stringify(r.d));
r = await chama(TK.kev, '/api/swweb/item', { tipo: 'text', escopo: 'eu', label: 'vazio', text: '   ' });
vale('mensagem vazia e recusada', r.st === 400, r.st + ' ' + JSON.stringify(r.d));
r = await chama(TK.kev, '/api/swweb/item', { tipo: 'funil', escopo: 'eu', label: 'sem passos', passos: [] });
vale('funil sem passo e recusado', r.st === 400, r.st + ' ' + JSON.stringify(r.d));
r = await chama(TK.kev, '/api/swweb/item', { tipo: 'pix', escopo: 'eu', label: 'x' });
vale('tipo desconhecido e recusado', r.st === 400, r.st + ' ' + JSON.stringify(r.d));
r = await chama(TK.kev, '/api/swweb/item', { tipo: 'text', escopo: 'eu', text: 'Mensagem sem nome que e bem comprida pra ver o corte do rotulo' });
ro = await roteiro(TK.kev);
const semNome = (ro.messages || []).find((x) => x.id === r.d.id);
vale('mensagem sem nome ganha o comeco do texto como nome', semNome && semNome.label === 'Mensagem sem nome que e bem comprida pra', JSON.stringify(semNome && semNome.label));
r = await chama(null, '/api/swweb/item', { tipo: 'text', text: 'oi' });
vale('sem login nao cria', r.st === 401, String(r.st));

_log('\n"VER COMO" E SO LEITURA\n');
ro = await roteiro(TK.dir, 'kev');
vale('no "ver como" a direcao ve os itens do vendedor', (ro.sequences || []).some((x) => x.id === S1), JSON.stringify(ids(ro.sequences)));
const antes = sq.prepare('SELECT COUNT(*) n FROM swweb_itens').get().n;
r = await chama(TK.dir, '/api/swweb/item?como=kev', { tipo: 'text', escopo: 'eu', text: 'pelo preview' });
const depois = sq.prepare('SELECT COUNT(*) n FROM swweb_itens').get().n;
vale('e gravar com ?como nao cria nada no nome do vendedor', !(sq.prepare("SELECT 1 FROM swweb_itens WHERE dono='kev' AND dados LIKE '%pelo preview%'").get()), 'status ' + r.st + ', linhas ' + antes + ' -> ' + depois);

_log('\n' + ok + ' certos, ' + falhas.length + ' errados');
process.exit(falhas.length ? 1 : 0);
