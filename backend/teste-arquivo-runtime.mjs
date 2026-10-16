// PROVA NO RUNTIME DE VERDADE (wrangler dev local, workerd + D1 local) do arquivo de leads.
// Uso (com wrangler dev --local na porta 8799): node teste-arquivo-runtime.mjs <state.json> <arquivo .sqlite do D1 local>
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const [ESTADO, SQLITE] = process.argv.slice(2)
const B = 'http://127.0.0.1:8799'
const H = { authorization: 'Bearer ' + 'c'.repeat(64), 'content-type': 'application/json' }
const get = async (p) => { const t0 = Date.now(); const r = await fetch(B + p, { headers: H }); const j = await r.json(); j.__ms = Date.now() - t0; return j }
const post = async (p, b) => { const t0 = Date.now(); const r = await fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { st: r.status, j: await r.json().catch(() => null), ms: Date.now() - t0 } }
const db = () => new DatabaseSync(SQLITE, { readOnly: true })
const arqIds = () => { const d = db(); try { return d.prepare('SELECT id FROM leads_arquivo').all().map((r) => String(r.id)) } catch { return [] } finally { d.close() } }
const arqJson = (id) => { const d = db(); try { const r = d.prepare('SELECT json FROM leads_arquivo WHERE id=?').get(id); return r ? JSON.parse(r.json) : null } finally { d.close() } }
const linha = () => { const d = db(); try { return d.prepare('SELECT data, version FROM dashboard_state WHERE id=1').get() } finally { d.close() } }
const orig = JSON.parse(fs.readFileSync(ESTADO, 'utf8'))
const ORIG_KEYS = new Set(Object.keys(orig))
const semAssin = (s) => s.replace(/(\/api\/arquivo\/[^"?]*)\?[^"]*/g, '$1')
const mapa = (leads) => new Map(leads.map((l) => [String(l.id), semAssin(JSON.stringify(l))]))
const outros = (d) => { const o = {}; for (const k of Object.keys(d).sort()) if (k !== 'leads' && ORIG_KEYS.has(k)) o[k] = d[k]; return semAssin(JSON.stringify(o)) }
const iguais = (a, b) => { if (a.size !== b.size) return 'tamanho ' + a.size + ' x ' + b.size; for (const [k, v] of a) if (b.get(k) !== v) return 'difere ' + k; return '' }
const paraPost = (d) => { const o = {}; for (const k of Object.keys(d)) if (ORIG_KEYS.has(k)) o[k] = d[k]; return o }
let ok = 0, falha = 0
const t = (n, c, x) => { if (c) { ok++; console.log('  ok  ' + n) } else { falha++; console.log('  FALHA ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x).slice(0, 300) : '')) } }

console.log('1. DESLIGADO: passagem direta')
const s0 = await get('/api/state')
const L0 = mapa(s0.data.leads), O0 = outros(s0.data)
t('GET devolve os ' + orig.leads.length + ' pedidos', s0.data.leads.length === orig.leads.length, s0.data.leads.length)
t('linha intocada no banco (sem _arq)', !linha().data.startsWith('{"_arq"'))
t('medidor = linha inteira', s0.blob && s0.blob.bytes === Buffer.byteLength(linha().data), s0.blob)
console.log('     GET /api/state: ' + s0.__ms + ' ms')
const a0 = await get('/api/state/arquivo')
t('situacao: desligado, arquivo vazio', a0.ok && a0.config.on === false && a0.arquivo.n === 0, a0)

console.log('2. RODAR ATE ESVAZIAR OS CANDIDATOS')
let passos = 0, total = 0, msMax = 0
for (; passos < 40; passos++) {
  const r = await post('/api/state/arquivo', { acao: 'rodar', dias: 7, lote: 60 })
  if (r.st !== 200 || !r.j.ok) { t('passo ' + passos, false, r); break }
  msMax = Math.max(msMax, r.ms)
  if (!r.j.passo.n) break
  total += r.j.passo.n
}
const a1 = await get('/api/state/arquivo')
console.log('     ' + passos + ' passos, ' + total + ' arquivados, passo mais lento ' + msMax + ' ms; linha ' + a1.linha.bytes + ' bytes (' + a1.pct + '%), arquivo ' + a1.arquivo.bytes + ' bytes')
t('arquivou e a conta bate com a tabela', total > 0 && a1.arquivo.n === total && arqIds().length === total, a1)
const s1 = await get('/api/state')
console.log('     GET /api/state: ' + s1.__ms + ' ms')
t('quem le ve os MESMOS pedidos, byte a byte', iguais(L0, mapa(s1.data.leads)) === '', iguais(L0, mapa(s1.data.leads)))
t('e o resto do estado igual', outros(s1.data) === O0)
t('medidor conta so a linha e mostra o arquivo', Math.abs(s1.blob.bytes - Buffer.byteLength(linha().data)) < 64 && s1.blob.arquivo && s1.blob.arquivo.n === total, s1.blob)
t('linha no formato canonico', linha().data.startsWith('{"_arq":') && linha().data.endsWith('],"_fim":1}'))

console.log('3. A TELA GRAVA O ESTADO INTEIRO (como o Kanban faz)')
const ids = arqIds()
const X = ids[0], Y = ids[1]
const d2 = paraPost(s1.data)
const lx = d2.leads.find((l) => String(l.id) === X); lx.comments = (lx.comments || []).concat([{ who: 'prova', tx: 'comentario no arquivado', time: '16/10 15:00' }])
const ly = d2.leads.find((l) => String(l.id) === Y); const colY = ly.col; ly.col = 'Cobrança'
const p2 = await post('/api/state', { data: d2, base_version: s1.version, app_version: '9.9.9' })
t('POST /api/state aceito', p2.st === 200 && p2.j && p2.j.ok, p2)
console.log('     POST /api/state: ' + p2.ms + ' ms')
const ax = arqJson(X)
t('arquivado que mudou e segue encerrado foi atualizado no arquivo', ax && (ax.comments || []).some((c) => c.tx === 'comentario no arquivado') && !JSON.parse(linha().data).leads.some((l) => String(l.id) === X))
t('arquivado reaberto voltou pra linha', !arqJson(Y) && JSON.parse(linha().data).leads.some((l) => String(l.id) === Y && l.col === 'Cobrança'), colY)
const s2 = await get('/api/state')
t('GET mostra as duas mudancas e o mesmo total', s2.data.leads.length === orig.leads.length && s2.data.leads.find((l) => String(l.id) === X).comments.some((c) => c.tx === 'comentario no arquivado') && s2.data.leads.find((l) => String(l.id) === Y).col === 'Cobrança')
const p3 = await post('/api/state', { data: paraPost(s1.data), base_version: s1.version, app_version: '9.9.9' })
t('aba velha (versao antiga) e recusada com 409, igual antes', p3.st === 409, p3.st)

console.log('4. DESFAZER: tudo volta pra linha')
let volt = 0
for (let i = 0; i < 20; i++) { const r = await post('/api/state/arquivo', { acao: 'voltar', max: 80, forca: true }); if (r.st !== 200) { t('voltar', false, r); break } if (!r.j.voltaram) break; volt += r.j.voltaram }
const a3 = await get('/api/state/arquivo')
const s3 = await get('/api/state')
t('arquivo vazio depois do voltar', a3.arquivo.n === 0 && arqIds().length === 0, a3)
t('mesmos pedidos do passo 3 depois de voltar tudo', iguais(mapa(s2.data.leads), mapa(s3.data.leads)) === '', iguais(mapa(s2.data.leads), mapa(s3.data.leads)))
console.log('\n' + ok + ' ok, ' + falha + ' falha(s)')
process.exit(falha ? 1 : 0)
