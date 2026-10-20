// Prova LOCAL da SESSAO NA NUVEM do SellWave Web (19/10/2026): roda o worker DE VERDADE (bundle do
// wrangler) contra um D1 de mentira (node:sqlite em memoria) e um R2 de mentira (Map). Nao toca em
// producao.
// Uso: npx wrangler deploy --dry-run --outdir <pasta>  e depois  node teste-sessao-nuvem.mjs <pasta>/worker.js
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const [bundle] = process.argv.slice(2)
const schema = JSON.parse(readFileSync('C:/Users/bruno/Desktop/Sale Made Inc/AXION/backend/teste-pedido-refeito-schema.json', 'utf8'))
const sq = new DatabaseSync(':memory:')
for (const o of schema) { try { sq.exec(o.sql) } catch (_) { /* tabela que o teste nao usa */ } }

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
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)) }

// R2 de mentira: so o que a rota usa.
const r2 = new Map()
const MEDIA = {
  async get(k) { const v = r2.get(k); return v ? { body: new Blob([v]).stream(), size: v.length } : null },
  async head(k) { return r2.has(k) ? { size: r2.get(k).length } : null },
  async put(k, body) { r2.set(k, Buffer.from(await new Response(body).arrayBuffer())) },
  async list({ prefix }) { return { objects: [...r2.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false } },
  async delete(ks) { for (const k of [].concat(ks)) r2.delete(k) },
}

const exp = Math.floor(Date.now() / 1000) + 86400
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('dir', 'bruno', 'x', 'Bruno', 'BR', 'diretor')
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('vend_kevin', 'kevin', 'x', 'Kevin', 'KV', 'atendente')
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('vend_outro', 'outro', 'x', 'Outro', 'OU', 'atendente')
const TK_DIR = 'd'.repeat(64), TK_VEN = 'a'.repeat(64), TK_OUT = 'b'.repeat(64)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK_DIR, 'dir', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK_VEN, 'vend_kevin', exp)
sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK_OUT, 'vend_outro', exp)
const NK = '1599999999'
const estado = { chips: [{ id: 1, num: '(15) 99999-9999', at: 'vend_kevin', st: 'ativo', wa_st: '', em_uso: true }], pressels: [], leads: [] }
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado))

const worker = (await import(pathToFileURL(bundle).href)).default
const env = { DB, MEDIA }
const ctx = { waitUntil: () => {} }
const pede = async (metodo, rota, { token, maquina, corpo, bin } = {}) => {
  const h = { authorization: 'Bearer ' + token, 'x-sw-maquina': maquina || '' }
  let body
  if (bin) { body = bin; h['content-type'] = 'application/octet-stream'; h['content-length'] = String(bin.length) }
  else if (corpo) { body = JSON.stringify(corpo); h['content-type'] = 'application/json' }
  const r = await worker.fetch(new Request('https://x' + rota, { method: metodo, headers: h, body }), env, ctx)
  const ct = r.headers.get('content-type') || ''
  if (ct.includes('octet-stream')) return { http: r.status, bin: Buffer.from(await r.arrayBuffer()) }
  let j = null
  try { j = await r.json() } catch (_) {}
  return { http: r.status, ...j }
}
const uso = (token, maquina, soltar) => pede('POST', '/api/swweb/uso', { token, maquina, corpo: { nk: NK, soltar: !!soltar } })
const h = (b) => createHash('sha256').update(b).digest('hex')

let ok = 0, mau = 0
const t = (cond, oque, det) => { if (cond) { ok++; console.log('  ok    ' + oque) } else { mau++; console.log('  FALHOU ' + oque + (det ? '  -> ' + det : '')) } }
const MAQ_BRUNO = 'mbruno0000000001', MAQ_KEVIN = 'mkevin0000000002'

console.log('── 1) sem o aluguel do numero, nada ──')
let r = await pede('GET', '/api/swweb/sessao?nk=' + NK, { token: TK_DIR, maquina: MAQ_BRUNO })
t(r.http === 409, 'sem aluguel a sessao nao e lida', 'http ' + r.http)

console.log('\n── 2) o Bruno pega o numero e salva a sessao ──')
r = await uso(TK_DIR, MAQ_BRUNO)
t(r.ok === true, 'o Bruno pega o aluguel', JSON.stringify(r))
r = await pede('GET', '/api/swweb/sessao?nk=' + NK, { token: TK_DIR, maquina: MAQ_BRUNO })
t(r.ok && r.ver === 0 && Buffer.from(r.chave, 'base64').length === 32 && Array.isArray(r.manifesto) && !r.manifesto.length,
  'a sessao nasce na versao 0 com chave de 32 bytes', JSON.stringify({ ver: r.ver, chave: (r.chave || '').length }))
const chave1 = r.chave
const A = Buffer.from('arquivo A cifrado'), B = Buffer.from('arquivo B cifrado')
r = await pede('PUT', '/api/swweb/sessao/obj?nk=' + NK + '&h=' + h(A) + '&i=0', { token: TK_DIR, maquina: MAQ_BRUNO, bin: A })
t(r.ok === true && !r.ja, 'o pedaco A sobe', JSON.stringify(r))
r = await pede('PUT', '/api/swweb/sessao/obj?nk=' + NK + '&h=' + h(A) + '&i=0', { token: TK_DIR, maquina: MAQ_BRUNO, bin: A })
t(r.ok === true && r.ja === true, 'o mesmo pedaco nao sobe duas vezes', JSON.stringify(r))
r = await pede('POST', '/api/swweb/sessao/fim', { token: TK_DIR, maquina: MAQ_BRUNO, corpo: { nk: NK, base: 0, manifesto: [{ p: 'IndexedDB/x/000003.log', h: h(A), n: 9, k: 1 }, { p: 'Local Storage/leveldb/CURRENT', h: h(B), n: 3, k: 1 }] } })
t(r.http === 409 && /Faltam 1/.test(r.error || ''), 'versao com pedaco faltando e recusada', JSON.stringify(r))
r = await pede('PUT', '/api/swweb/sessao/obj?nk=' + NK + '&h=' + h(B) + '&i=0', { token: TK_DIR, maquina: MAQ_BRUNO, bin: B })
const man1 = [{ p: 'IndexedDB/x/000003.log', h: h(A), n: 9, k: 1 }, { p: 'Local Storage/leveldb/CURRENT', h: h(B), n: 3, k: 1 }]
r = await pede('POST', '/api/swweb/sessao/fim', { token: TK_DIR, maquina: MAQ_BRUNO, corpo: { nk: NK, base: 0, manifesto: man1 } })
t(r.ok === true && r.ver === 1, 'com tudo la a versao 1 fecha', JSON.stringify(r))
r = await pede('POST', '/api/swweb/sessao/fim', { token: TK_DIR, maquina: MAQ_BRUNO, corpo: { nk: NK, base: 0, manifesto: man1 } })
t(r.http === 409 && r.conflito === true && r.ver === 1, 'uma copia velha (base 0) chegando depois e recusada', JSON.stringify(r))
for (const p of ['../../Windows/x', 'IndexedDB/../../x', '/IndexedDB/x', 'Cache/x', 'IndexedDB//x', 'IndexedDB/a\\b']) {
  r = await pede('POST', '/api/swweb/sessao/fim', { token: TK_DIR, maquina: MAQ_BRUNO, corpo: { nk: NK, base: 1, manifesto: [{ p, h: h(A), n: 1, k: 1 }] } })
  t(r.http === 400, 'caminho hostil recusado: ' + p, 'http ' + r.http + ' ' + JSON.stringify(r))
}

console.log('\n── 3) o Kevin, em outra maquina, nao le enquanto o Bruno esta com o numero ──')
r = await uso(TK_VEN, MAQ_KEVIN)
t(r.ok === false && !!r.ocupado, 'o aluguel do Kevin e recusado (o Bruno esta com ele)', JSON.stringify(r))
r = await pede('GET', '/api/swweb/sessao?nk=' + NK, { token: TK_VEN, maquina: MAQ_KEVIN })
t(r.http === 409, 'e sem aluguel ele nao le a sessao', 'http ' + r.http)
r = await pede('GET', '/api/swweb/sessao/obj?nk=' + NK + '&h=' + h(A) + '&i=0', { token: TK_VEN, maquina: MAQ_KEVIN })
t(r.http === 409, 'nem um pedaco', 'http ' + r.http)

console.log('\n── 4) o Bruno solta, o Kevin abre e le a versao 1 ──')
await uso(TK_DIR, MAQ_BRUNO, true)
r = await uso(TK_VEN, MAQ_KEVIN)
t(r.ok === true, 'o Kevin pega o aluguel', JSON.stringify(r))
r = await pede('GET', '/api/swweb/sessao?nk=' + NK, { token: TK_VEN, maquina: MAQ_KEVIN })
t(r.ok && r.ver === 1 && r.chave === chave1 && r.manifesto.length === 2 && r.nome === 'Bruno', 'ele ve a versao 1, a mesma chave e quem salvou', JSON.stringify({ ver: r.ver, n: (r.manifesto || []).length, nome: r.nome }))
r = await pede('GET', '/api/swweb/sessao/obj?nk=' + NK + '&h=' + h(A) + '&i=0', { token: TK_VEN, maquina: MAQ_KEVIN })
t(r.http === 200 && r.bin && r.bin.equals(A), 'e baixa o pedaco igual ao que subiu', 'http ' + r.http)

console.log('\n── 5) o vendedor de OUTRO numero nao pega o aluguel deste ──')
r = await uso(TK_OUT, 'moutro0000000003')
t(r.http === 403, 'aluguel recusado pra quem nao e dono', 'http ' + r.http)

console.log('\n── 6) a limpeza guarda a versao nova e a anterior ──')
const C = Buffer.from('arquivo C'), D = Buffer.from('arquivo D')
await pede('PUT', '/api/swweb/sessao/obj?nk=' + NK + '&h=' + h(C) + '&i=0', { token: TK_VEN, maquina: MAQ_KEVIN, bin: C })
r = await pede('POST', '/api/swweb/sessao/fim', { token: TK_VEN, maquina: MAQ_KEVIN, corpo: { nk: NK, base: 1, manifesto: [{ p: 'IndexedDB/x/000005.log', h: h(C), n: 9, k: 1 }, man1[1]] } })
t(r.ok && r.ver === 2, 'o Kevin fecha a versao 2', JSON.stringify(r))
const chaveObj = (b) => 'swweb-sessao/' + NK + '/o/' + h(b) + '.0'
t(r2.has(chaveObj(A)) && r2.has(chaveObj(B)) && r2.has(chaveObj(C)), 'o arquivo A (so da versao 1) continua: a anterior e a volta')
await pede('PUT', '/api/swweb/sessao/obj?nk=' + NK + '&h=' + h(D) + '&i=0', { token: TK_VEN, maquina: MAQ_KEVIN, bin: D })
r = await pede('POST', '/api/swweb/sessao/fim', { token: TK_VEN, maquina: MAQ_KEVIN, corpo: { nk: NK, base: 2, manifesto: [{ p: 'IndexedDB/x/000007.log', h: h(D), n: 9, k: 1 }, man1[1]] } })
t(r.ok && r.ver === 3, 'versao 3', JSON.stringify(r))
t(!r2.has(chaveObj(A)) && r2.has(chaveObj(B)) && r2.has(chaveObj(C)) && r2.has(chaveObj(D)), 'agora o A (de duas versoes atras) saiu e o resto ficou', JSON.stringify([...r2.keys()]))

console.log('\n── 7) a rota publica de midia nao entrega sessao ──')
for (const rota of ['/api/salechat/media/' + chaveObj(D), '/api/arquivo/' + encodeURIComponent(chaveObj(D))]) {
  const rr = await worker.fetch(new Request('https://x' + rota), env, ctx)
  t(rr.status === 404, 'sem login nao sai: ' + rota.slice(0, 40), 'http ' + rr.status)
}

console.log('\n── 8) a lista de numeros diz que a sessao esta na nuvem ──')
r = await pede('GET', '/api/swweb/numeros', { token: TK_VEN, maquina: MAQ_KEVIN })
const n0 = (r.numeros || []).find((x) => x.nk === NK)
t(n0 && n0.nuvem && n0.nuvem.ver === 3 && n0.nuvem.nome === 'Kevin', 'campo nuvem com a versao e quem salvou', JSON.stringify(n0 && n0.nuvem) + ' http ' + r.http)
t(n0 && n0.uso && n0.uso.meu === true, 'e o aluguel aparece como DESTA maquina (uso.meu)', JSON.stringify(n0 && n0.uso))

console.log('\n' + ok + ' de ' + (ok + mau) + '\n')
process.exit(mau ? 1 : 0)
