// O FEED E O INSTALADOR DE MAC DO SELLWAVE WEB (04/11/2026).
//
// O cobrador novo usa MacBook. O .dmg sai do runner macOS do GitHub e pode ficar atras do .exe, entao
// o Mac tem versao propria (swweb_app_mac). O furo que este teste guarda: o app de Mac lendo a versao
// do Windows pediria, em toda abertura, pra baixar uma versao que nao existe pra ele; e o carimbo do
// Mac nao pode pisar no do Windows (o pop-up de todo vendedor sai dele).
//
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-swweb-mac.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) {} }
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)
function stmt(sql, args = []) {
  return {
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } } },
  }
}
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())), exec: async (s) => sq.exec(s) }
globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })

const exp = Math.floor(Date.now() / 1000) + 86400
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,com_pct) VALUES (?,?,?,?,?,?,?)').run('dir', 'dir', 'x', 'Diretor', 'DI', 'diretor', 0)
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role,com_pct) VALUES (?,?,?,?,?,?,?)').run('cob', 'cob', 'x', 'Bryan', 'BR', 'cobrador', 3)
const TK = { dir: 'd'.repeat(64), cob: 'c'.repeat(64) }
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.dir, 'dir', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK.cob, 'cob', exp)
sq.prepare('INSERT INTO dashboard_state (id,data,version,updated_at,updated_by) VALUES (1,?,1,0,?)').run(JSON.stringify({ leads: [] }), 'teste')

// R2 de mentira: so o que a rota usa (get com body e size).
const r2 = new Map()
const MEDIA = {
  get: async (k) => { const v = r2.get(k); return v ? { body: v, size: v.length } : null },
  put: async (k, v) => { r2.set(k, v) },
}

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};' }).join(' '))
const copia = bundle.replace(/\.js$/, '') + '-teste-swweb-mac.mjs'
writeFileSync(copia, fonte)
const worker = (await import(pathToFileURL(copia).href)).default
const env = { DB, MEDIA }
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
const API = 'https://axion-api.axion-dash.workers.dev'
const pede = async (metodo, caminho, tok, corpo) => {
  const h = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 teste' }
  if (tok) h.Authorization = 'Bearer ' + tok
  const r = await worker.fetch(new Request(API + caminho, { method: metodo, headers: h, body: corpo ? JSON.stringify(corpo) : undefined }), env, ctx)
  const tipo = r.headers.get('content-type') || ''
  return { st: r.status, h: r.headers, d: tipo.includes('json') ? await r.json().catch(() => null) : await r.text() }
}

let ok = 0, falhas = 0
const conta = (nome, passou, det) => { if (passou) ok++; else falhas++; console.log((passou ? '  OK   ' : '  FALHA') + '  ' + nome + (det !== undefined ? '  ->  ' + det : '')) }

// 1) carimbos: Windows e Mac separados, so a direcao
let r = await pede('POST', '/api/swweb/app', TK.dir, { versao: '1.26.3', bytes: 110e6, notas: 'windows' })
conta('a direcao carimba o Windows como sempre', r.st === 200 && r.d && r.d.so === 'win', r.st + ' ' + JSON.stringify(r.d).slice(0, 80))
r = await pede('POST', '/api/swweb/app', TK.dir, { versao: '1.26.4', bytes: 230e6, notas: 'mac', so: 'mac' })
conta('a direcao carimba o Mac com so=mac', r.st === 200 && r.d && r.d.so === 'mac', r.st + ' ' + JSON.stringify(r.d).slice(0, 80))
r = await pede('POST', '/api/swweb/app', TK.cob, { versao: '9.9.9', so: 'mac' })
conta('cobrador NAO carimba versao de Mac', r.st === 403, r.st)

// 2) a versao: sem so = Windows (o que todo app de Windows ja instalado pede); so=mac = Mac
r = await pede('GET', '/api/swweb/versao')
conta('sem so: a versao continua a do Windows', r.d && r.d.versao === '1.26.3' && r.d.notas === 'windows', JSON.stringify(r.d))
conta('sem so: o link continua o instalador .exe', r.d && /\/api\/swweb\/instalador$/.test(r.d.url), r.d && r.d.url)
r = await pede('GET', '/api/swweb/versao?so=mac')
conta('so=mac: a versao e a do Mac', r.d && r.d.versao === '1.26.4' && r.d.notas === 'mac', JSON.stringify(r.d))
conta('so=mac: o link e o .dmg', r.d && /\/api\/swweb\/instalador-mac$/.test(r.d.url), r.d && r.d.url)
conta('a resposta tem CORS (a tela da dash le essa rota)', !!r.h.get('access-control-allow-origin'), r.h.get('access-control-allow-origin'))

// 3) o carimbo do Mac nao pisou no do Windows
const cfg = sq.prepare("SELECT key, value FROM app_config WHERE key IN ('swweb_app','swweb_app_mac') ORDER BY key").all()
conta('dois carimbos, um por sistema', cfg.length === 2 && JSON.parse(cfg[0].value).versao === '1.26.3' && JSON.parse(cfg[1].value).versao === '1.26.4', cfg.map((c) => c.key + '=' + JSON.parse(c.value).versao).join(' '))

// 4) o instalador de Mac: 404 claro antes de publicar, o .dmg depois, sem token
r = await pede('GET', '/api/swweb/instalador-mac')
conta('sem .dmg no R2: 404 dizendo que nao foi publicado', r.st === 404 && /Mac/.test(JSON.stringify(r.d)), r.st + ' ' + JSON.stringify(r.d))
await MEDIA.put('sellwave-web/instalador-mac.dmg', new Uint8Array([1, 2, 3, 4, 5]))
r = await pede('GET', '/api/swweb/instalador-mac')
conta('com .dmg: baixa sem login', r.st === 200, r.st)
conta('o arquivo chega com o nome certo', /SellWave Web\.dmg/.test(r.h.get('content-disposition') || ''), r.h.get('content-disposition'))
conta('tipo de imagem de disco da Apple', r.h.get('content-type') === 'application/x-apple-diskimage', r.h.get('content-type'))
r = await pede('GET', '/api/swweb/instalador-mac?versao=cobrador')
conta('?versao=cobrador (o botao do cobrador) baixa o mesmo .dmg', r.st === 200, r.st)
r = await pede('GET', '/api/swweb/instalador')
conta('o instalador de Windows nao mudou (sem .exe no R2 de teste: 404 de sempre)', r.st === 404 && /instalador/.test(JSON.stringify(r.d)), r.st)

console.log('\n' + ok + ' de ' + (ok + falhas) + ' passaram.')
process.exit(falhas ? 1 : 0)
