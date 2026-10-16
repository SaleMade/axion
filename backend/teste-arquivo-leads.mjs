// PROVA DO ITEM 22 (arquivo de leads). Roda o worker de verdade (copia com o patch) contra um SQLite
// de verdade com a copia do estado de producao. Uso: node teste-arquivo-leads.mjs <worker.js com o patch> <state.json>
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { criaD1 } from './teste-arquivo-d1.mjs'

const [W, ESTADO] = process.argv.slice(2)
const dir = path.dirname(W)
const src = fs.readFileSync(W, 'utf8') + `
export { _arqEnvolve, _arqCron, _arqTempo, _arqUltimoMov, _arqPassouDoTeto, _arqGenDe, _arqJunta, _arqTipoSql, handleStateArquivo, handleStateTrim, _cronEnxugarLeads, _trimBlobData, _readConfig, _writeConfig };
export function __arqZera() { _arqCache = null; _arqVerGen.clear(); _arqVazioAte = 0; _arqTabelaOk = false; }
export function __arqEspia() { return { cache: _arqCache, verGen: _arqVerGen }; }
export function __set(o) { for (const k of Object.keys(o)) { switch (k) { case 'authUser': authUser = o[k]; break; case 'isDirector': isDirector = o[k]; break; default: throw new Error('sem __set pra ' + k); } } }
`
const copia = path.join(dir, 'w-prova.mjs')
fs.writeFileSync(copia, src)
// DOIS "ISOLATES": o mesmo modulo carregado duas vezes = dois caches independentes, um banco so
const A = await import(pathToFileURL(copia).href + '?iso=a')
const B = await import(pathToFileURL(copia).href + '?iso=b')
A.__set({ authUser: async () => ({ id: 'dir', user_id: 'dir', role: 'diretor' }), isDirector: () => true })

let ok = 0, falha = 0
const t = (nome, cond, extra) => { if (cond) { ok++; if (!process.env.QUIETO) console.log('  ok  ' + nome) } else { falha++; console.log('  FALHA ' + nome + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 400) : '')) } }
const SEL = 'SELECT data, version FROM dashboard_state WHERE id = 1'
const UPD = 'UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?'
const bytes = (s) => Buffer.byteLength(s)
const ORIG = fs.readFileSync(ESTADO, 'utf8')
const origObj = JSON.parse(ORIG)
const TERM = new Set(['Pago', 'Pagos', 'Cancelado', 'Cancelado sem Custo', 'Devolvido', 'Roubos', 'Frustrados'])

function banco(dataStr = ORIG, ver = 100) {
  const d1 = criaD1()
  d1.__db.exec('CREATE TABLE dashboard_state (id INTEGER PRIMARY KEY, data TEXT, version INTEGER, updated_at INTEGER, updated_by TEXT)')
  d1.__db.prepare('INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, 0, ?)').run(dataStr, ver, 'prova')
  return d1
}
const cru = (d1) => d1.__db.prepare('SELECT data, version, updated_by FROM dashboard_state WHERE id = 1').get()
const arqLinhas = (d1) => { try { return d1.__db.prepare('SELECT id, json, col FROM leads_arquivo ORDER BY rowid').all() } catch { return [] } }
const env = (mod, d1) => mod._arqEnvolve({ DB: d1, MEDIA: null, OUTRA: 'x' })
const porId = (leads) => { const m = new Map(); for (const l of leads) m.set(String(l.id), JSON.stringify(l)); return m }
const mesmoConjunto = (a, b) => { if (a.size !== b.size) return 'tamanho ' + a.size + ' x ' + b.size; for (const [k, v] of a) { if (b.get(k) !== v) return 'difere ' + k } return '' }
const resto = (d) => { const o = {}; for (const k of Object.keys(d).sort()) if (k !== 'leads') o[k] = d[k]; return JSON.stringify(o) }
const le = async (e, sql = SEL) => e.DB.prepare(sql).first()
// le-altera-grava com a trava de versao, igual aos 34 gravadores do worker
async function rmw(e, muda, quem = 'prova') {
  for (let i = 0; i < 4; i++) {
    const row = await le(e)
    const d = JSON.parse(row.data)
    muda(d)
    const r = await e.DB.prepare(UPD).bind(JSON.stringify(d), row.version + 1, 1, quem, row.version).run()
    if (r && r.meta && r.meta.changes > 0) return true
  }
  return false
}
// o banco por dentro: nenhum pedido em dois lugares, linha no formato, arquivo so com encerrado
function confere(d1, nome) {
  const r = cru(d1)
  const linhas = arqLinhas(d1)
  const gen = A._arqGenDe(r.data)
  let blob; try { blob = JSON.parse(r.data) } catch { t(nome + ': linha e JSON', false); return null }
  const idsBlob = new Set((blob.leads || []).map((l) => String(l.id)))
  const dup = linhas.filter((x) => idsBlob.has(String(x.id))).length
  const naoTerm = linhas.filter((x) => !TERM.has(JSON.parse(x.json).col)).length
  const canon = gen === 0 ? !('_arq' in blob) : (r.data.startsWith('{"_arq":' + gen + ',') && r.data.endsWith('],"_fim":1}'))
  const okk = dup === 0 && naoTerm === 0 && canon && bytes(r.data) < 2000000 && (gen > 0 || linhas.length === 0)
  if (!okk) t(nome + ': banco coerente', false, { dup, naoTerm, canon, gen, bytes: bytes(r.data), arq: linhas.length })
  return { gen, nBlob: idsBlob.size, nArq: linhas.length, bytes: bytes(r.data) }
}

console.log('1. ARQUIVO NUNCA USADO = PASSAGEM DIRETA (o que sobe hoje, antes de ligar)')
{
  const d1 = banco(); const e = env(A, d1)
  const row = await le(e)
  t('leitura devolve a linha byte a byte', row.data === ORIG && row.version === 100)
  t('as outras duas formas de SELECT tambem', (await le(e, 'SELECT data FROM dashboard_state WHERE id = 1')).data === ORIG && (await le(e, 'SELECT data, version, updated_at, updated_by FROM dashboard_state WHERE id = 1')).updated_by === 'prova')
  const d = JSON.parse(row.data); d.notifs = (d.notifs || []).concat([{ id: 'x' }])
  const novo = JSON.stringify(d)
  const r = await e.DB.prepare(UPD).bind(novo, 101, 1, 'prova', 100).run()
  t('gravacao grava exatamente a string que recebeu, sem _arq', r.meta.changes === 1 && cru(d1).data === novo && !cru(d1).data.includes('"_arq"'))
  const r2 = await e.DB.prepare('UPDATE dashboard_state SET data = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = 1 AND version = ?').bind(novo, 102, 1, 'p', 999).run()
  t('trava de versao recusa como antes (0 linhas)', r2.meta.changes === 0)
  t('SQL que nao e do estado passa direto; os bindings do env continuam la', e.OUTRA === 'x' && A._arqTipoSql('SELECT value FROM app_config WHERE key = ?') === null && A._arqTipoSql('SELECT version FROM dashboard_state WHERE id = 1') === null && A._arqTipoSql("SELECT json_extract(data, '$.notifs') n FROM dashboard_state WHERE id = 1") === null && A._arqTipoSql('INSERT OR IGNORE INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)') === null)
  t('as 6 formas de SQL do estado no worker sao reconhecidas', ['SELECT data, version FROM dashboard_state WHERE id = 1', 'SELECT data FROM dashboard_state WHERE id = 1', 'SELECT data, version, updated_at, updated_by FROM dashboard_state WHERE id = 1'].every((s) => A._arqTipoSql(s) === 'le') && ['UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?', 'UPDATE dashboard_state SET data = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = 1 AND version = ?'].every((s) => A._arqTipoSql(s) === 'grava'))
  // quantas consultas a mais custa o envelope com o arquivo desligado? (uma, de 5 em 5 min por isolate)
  A.__arqZera(); d1.__conta.consultas = 0
  for (let i = 0; i < 20; i++) await le(e)
  t('20 leituras com o arquivo vazio = 21 consultas (1 conferencia do arquivo, que vale 5 min)', d1.__conta.consultas === 21, d1.__conta.consultas)
  let estourou = false; try { await e.DB.batch([e.DB.prepare(SEL)]) } catch { estourou = true }
  t('estado dentro de batch() e recusado em voz alta (ninguem usa hoje)', estourou)
}

console.log('2. RELOGIO DOS CARIMBOS')
{
  const agora = Date.UTC(2026, 9, 13, 3, 0)   // 13/10/2026 00:00 em Brasilia
  t('ISO', A._arqTempo('2026-10-08T23:22:21.695Z', agora) === Date.parse('2026-10-08T23:22:21.695Z'))
  t('"DD/MM HH:MM" e hora de Brasilia do ano corrente', A._arqTempo('09/10 23:42', agora) === Date.UTC(2026, 9, 10, 2, 42))
  t('"DD/MM HH:MM" que cairia no futuro volta um ano', A._arqTempo('25/12 10:00', agora) === Date.UTC(2025, 11, 25, 13, 0))
  t('epoch em ms e em s', A._arqTempo(1791600156442, 1791600156442 + 5e8) === 1791600156442 && A._arqTempo(1791501741, 1791600156442) === 1791501741000)
  t('lixo, vazio e data no futuro = 0', A._arqTempo('', agora) === 0 && A._arqTempo('amanha', agora) === 0 && A._arqTempo(5, agora) === 0 && A._arqTempo('2031-01-01T00:00:00Z', agora) === 0)
  t('ultimo movimento = o carimbo mais novo entre historico, comentario e pagamento', A._arqUltimoMov({ id: 1, hist: [{ time: '01/10 10:00' }, { time: '2026-10-05T10:00:00Z' }], comments: [{ time: '07/10 09:00' }], pago_ts: 1 }, agora) === Date.UTC(2026, 9, 7, 12, 0))
  t('pedido sem carimbo nenhum cai no id (ms da criacao)', A._arqUltimoMov({ id: 1791051817671 }, 1791051817671 + 9e9) === 1791051817671)
}

const AGORA = Date.now()
console.log('3. O CRON ARQUIVA, E QUEM LE NAO PERCEBE')
const d1 = banco(); const eA = env(A, d1), eB = env(B, d1)
A.__arqZera(); B.__arqZera()
{
  t('desligado sai sem tocar em nada', (await A._arqCron(eA)).desligado === true && arqLinhas(d1).length === 0 && cru(d1).data === ORIG)
  const r = await A._arqCron(eA, { dias: 7, lote: 25 })
  const c = confere(d1, 'apos o 1o lote')
  t('1o lote: 25 pedidos na tabela, geracao 1', r.ok && r.n === 25 && c.nArq === 25 && c.gen === 1, { r, c })
  const row = await le(eA); const d = JSON.parse(row.data)
  t('leitura (mesmo isolate): mesmos ' + origObj.leads.length + ' pedidos, um a um, e nenhuma chave nova', mesmoConjunto(porId(d.leads), porId(origObj.leads)) === '' && resto(d) === resto(origObj) && !('_arq' in d) && !('_fim' in d), mesmoConjunto(porId(d.leads), porId(origObj.leads)))
  const rowB = await le(eB)
  t('leitura (outro isolate, cache frio): identica', rowB.data === row.data && rowB.version === row.version)
  t('SELECT data sozinho e o de 4 colunas: identicos', (await le(eA, 'SELECT data FROM dashboard_state WHERE id = 1')).data === row.data && (await le(eB, 'SELECT data, version, updated_at, updated_by FROM dashboard_state WHERE id = 1')).data === row.data)
  const arq = arqLinhas(d1).map((x) => JSON.parse(x.json))
  t('so encerrado e parado ha 7+ dias foi arquivado', arq.every((l) => TERM.has(l.col) && A._arqUltimoMov(l, AGORA) <= AGORA - 7 * 86400000))
  let n = 25, voltas = 0
  while (voltas++ < 40) { const x = await (voltas % 2 ? B : A)._arqCron(voltas % 2 ? eB : eA, { dias: 7, lote: 40 }); if (!x.n) break; n += x.n }
  const esperado = origObj.leads.filter((l) => TERM.has(l.col) && A._arqUltimoMov(l, AGORA) > 0 && A._arqUltimoMov(l, AGORA) <= AGORA - 7 * 86400000).length
  const c2 = confere(d1, 'apos drenar')
  t('drenado em lotes, alternando isolates: ' + n + ' arquivados = todos os elegiveis (' + esperado + ')', n === esperado && c2.nArq === esperado, { n, esperado, c2 })
  console.log('     linha: ' + bytes(ORIG) + ' -> ' + c2.bytes + ' bytes (' + (c2.bytes / 20000).toFixed(1) + '% de 2 MB); arquivo: ' + c2.nArq + ' pedidos; na linha: ' + c2.nBlob)
  const d2 = JSON.parse((await le(eA)).data)
  t('depois de drenar: mesmos pedidos e mesmo resto', mesmoConjunto(porId(d2.leads), porId(origObj.leads)) === '' && resto(d2) === resto(origObj))
  const soma = (L) => { let pagos = 0, receita = 0; const col = {}; for (const l of L) { col[l.col] = (col[l.col] || 0) + 1; if (l.spg === 'Pago') { pagos++; receita += Number(l.vl_cobrado || l.vl || 0) || 0 } } return JSON.stringify({ pagos, receita: Math.round(receita * 100), col: Object.keys(col).sort().map((k) => k + ':' + col[k]) }) }
  t('pagos, receita e contagem por coluna: iguais antes e depois', soma(d2.leads) === soma(origObj.leads))
  t('rodar de novo com tudo arquivado = 0 (nao rearquiva)', (await A._arqCron(eA, { dias: 7, lote: 40 })).n === 0)
}

console.log('4. GRAVACAO COMUM COM O ARQUIVO CHEIO')
const arqIds = () => arqLinhas(d1).map((x) => String(x.id))
{
  const antes = cru(d1), nArq = arqLinhas(d1).length, gen0 = A._arqGenDe(antes.data)
  d1.__conta.consultas = 0; d1.__conta.lotes = 0
  t('le e regrava sem mudar nada: grava', await rmw(eA, () => {}))
  const dep = cru(d1)
  t('  ...a linha fica identica, o arquivo intocado, a geracao a mesma, sem lote, 2 consultas', dep.data === antes.data && arqLinhas(d1).length === nArq && A._arqGenDe(dep.data) === gen0 && d1.__conta.lotes === 0 && d1.__conta.consultas === 2, { c: d1.__conta.consultas, l: d1.__conta.lotes })
  const idVivo = JSON.parse(antes.data).leads[0].id
  await rmw(eA, (d) => { d.leads.find((l) => l.id === idVivo).obs = 'mexi no vivo' })
  t('mexer em pedido que esta na linha nao toca no arquivo', arqLinhas(d1).length === nArq && A._arqGenDe(cru(d1).data) === gen0 && JSON.parse(cru(d1).data).leads.find((l) => l.id === idVivo).obs === 'mexi no vivo')
  const idA = arqIds()[3]
  await rmw(eA, (d) => { const l = d.leads.find((x) => String(x.id) === idA); l.comments = (l.comments || []).concat([{ time: '12/10 23:00', who: 'dir', tx: 'comentario novo' }]) })
  const linhaA = arqLinhas(d1).find((x) => String(x.id) === idA)
  t('comentario em pedido arquivado: atualiza NO arquivo, geracao sobe, nao volta pra linha', JSON.parse(linhaA.json).comments.some((c) => c.tx === 'comentario novo') && A._arqGenDe(cru(d1).data) === gen0 + 1 && !JSON.parse(cru(d1).data).leads.some((l) => String(l.id) === idA))
  t('  ...e o outro isolate ja le o comentario (cache trocado pela geracao)', JSON.parse((await le(eB)).data).leads.find((l) => String(l.id) === idA).comments.some((c) => c.tx === 'comentario novo'))
  const idB = arqIds()[5]
  await rmw(eB, (d) => { const l = d.leads.find((x) => String(x.id) === idB); l.col = 'Cobrança'; l.spg = 'Pendente' })
  t('pedido arquivado que reabre (estorno) VOLTA pra linha e sai do arquivo', !arqIds().includes(idB) && JSON.parse(cru(d1).data).leads.some((l) => String(l.id) === idB && l.col === 'Cobrança'))
  const idC = arqIds()[7]
  await rmw(eA, (d) => { d.leads = d.leads.filter((l) => String(l.id) !== idC) })
  t('excluir um pedido arquivado: some do arquivo e da leitura', !arqIds().includes(idC) && !JSON.parse((await le(eB)).data).leads.some((l) => String(l.id) === idC))
  const seis = arqIds().slice(10, 16)
  await rmw(eA, (d) => { d.leads = d.leads.filter((l) => !seis.includes(String(l.id))) })
  t('gravacao que chega sem 6 arquivados NAO apaga nenhum (reaparecem na leitura)', seis.every((id) => arqIds().includes(id)) && JSON.parse((await le(eA)).data).leads.filter((l) => seis.includes(String(l.id))).length === 6)
  const eLib = env(A, d1); eLib.DB.__arqSumirAte = Infinity
  await rmw(eLib, (d) => { d.leads = d.leads.filter((l) => !seis.includes(String(l.id))) })
  t('com a liberacao explicita do diretor, apaga os 6', seis.every((id) => !arqIds().includes(id)))
  confere(d1, 'apos as gravacoes comuns')
}

console.log('5. DOIS GRAVANDO AO MESMO TEMPO')
{
  const rowA = await le(eA), rowB = await le(eB)
  const idX = arqIds()[2], idY = arqIds()[4]
  const dA = JSON.parse(rowA.data); dA.leads.find((l) => String(l.id) === idX).obs = 'A ganhou'
  const dB = JSON.parse(rowB.data); dB.leads.find((l) => String(l.id) === idY).obs = 'B perdeu'; dB.leads.find((l) => String(l.id) === idX).col = 'Cobrança'
  const rA = await eA.DB.prepare(UPD).bind(JSON.stringify(dA), rowA.version + 1, 1, 'A', rowA.version).run()
  const fotoArq = JSON.stringify(arqLinhas(d1)), fotoLinha = cru(d1).data
  const rB = await eB.DB.prepare(UPD).bind(JSON.stringify(dB), rowB.version + 1, 1, 'B', rowB.version).run()
  t('o primeiro grava; o segundo, com a versao velha, leva 0 linhas', rA.meta.changes === 1 && rB.meta.changes === 0)
  t('  ...e a gravacao recusada nao deixou NADA: nem na linha, nem no arquivo', JSON.stringify(arqLinhas(d1)) === fotoArq && cru(d1).data === fotoLinha)
  t('  ...o perdedor rele e ve o estado do vencedor', JSON.parse((await le(eB)).data).leads.find((l) => String(l.id) === idX).obs === 'A ganhou')
  const row = await le(eA); const d = JSON.parse(row.data); d.leads.find((l) => String(l.id) === idY).obs = 'isolate novo'
  B.__arqZera()
  const r = await eB.DB.prepare(UPD).bind(JSON.stringify(d), row.version + 1, 1, 'frio', row.version).run()
  t('gravador com o cache frio (isolate novo no meio): grava certo', r.meta.changes === 1 && JSON.parse(arqLinhas(d1).find((x) => String(x.id) === idY).json).obs === 'isolate novo')
  B.__arqZera()
  const r3 = await eB.DB.prepare(UPD).bind(JSON.stringify(d), row.version + 5, 1, 'frio-velho', row.version).run()
  t('gravador com o cache frio E versao velha: 0 linhas, sem estourar', r3.meta.changes === 0)
  confere(d1, 'apos concorrencia')
}

console.log('6. FUNCOES DE VERDADE DO WORKER, SEM MUDAR UMA LINHA DELAS')
{
  const alvoArq = arqIds().slice(0, 2), alvoVivo = JSON.parse(cru(d1).data).leads.slice(0, 2).map((l) => String(l.id))
  await rmw(eA, (d) => { for (const l of d.leads) if (alvoArq.includes(String(l.id)) || alvoVivo.includes(String(l.id))) l.raw = { lixo: 'x'.repeat(50) } })
  t('preparo: raw gravado nos 4 (2 ficaram no arquivo)', arqLinhas(d1).filter((x) => alvoArq.includes(String(x.id)) && JSON.parse(x.json).raw).length === 2)
  await A._cronEnxugarLeads(eA)
  const dd = JSON.parse((await le(eB)).data)
  t('_cronEnxugarLeads limpa o raw dos 4, na linha e no arquivo', dd.leads.every((l) => !('raw' in l)) && arqLinhas(d1).every((x) => !('raw' in JSON.parse(x.json))) && cru(d1).updated_by === 'enxuga-leads')
  const req = (m, b) => ({ method: m, json: async () => b || {}, headers: { get: () => '' } })
  const st = await (await A.handleStateArquivo(req('GET'), eA)).json()
  t('GET /api/state/arquivo: situacao bate com o banco', st.ok && st.arquivo.n === arqLinhas(d1).length && st.linha.gen === A._arqGenDe(cru(d1).data) && st.linha.bytes === Buffer.byteLength(cru(d1).data) && st.config.on === false, st)
  const lig = await (await A.handleStateArquivo(req('POST', { acao: 'ligar', dias: 10, lote: 30 }), eA)).json()
  t('ligar grava a config; o cron passa a rodar', lig.config.on === true && lig.config.dias === 10 && lig.config.lote === 30 && (await A._arqCron(eA)).ok === true)
  const nAntes = arqLinhas(d1).length
  const vol = await (await A.handleStateArquivo(req('POST', { acao: 'voltar', max: 15 }), eA)).json()
  t('voltar devolve 15 pedidos pra linha, sem perder nenhum', vol.voltaram === 15 && arqLinhas(d1).length === nAntes - 15, vol)
  await (await A.handleStateArquivo(req('POST', { acao: 'desligar' }), eA)).json()
  t('desligar: o cron volta a sair na primeira linha', (await A._arqCron(eA)).desligado === true)
  const merged = (await le(eA)).data
  t('corte de emergencia: estado de ' + bytes(merged) + ' bytes com a linha pequena NAO dispara', A._arqPassouDoTeto(merged) === false && A._arqPassouDoTeto(merged + 'x'.repeat(1700000)) === true)
  confere(d1, 'apos as funcoes do worker')
}

console.log('7. ESTADO REGRAVADO POR FORA DO WORKER (o pior caso)')
{
  const r = cru(d1); const blob = JSON.parse(r.data); delete blob._arq; delete blob._fim
  const dupId = arqIds()[0]; blob.leads.push({ ...JSON.parse(arqLinhas(d1)[0].json), obs: 'copia velha na linha' })
  d1.__db.prepare('UPDATE dashboard_state SET data = ?, version = version + 1').run(JSON.stringify(blob))
  A.__arqZera(); B.__arqZera()
  const row = await le(eA); const d = JSON.parse(row.data)
  const ids = d.leads.map((l) => String(l.id))
  t('a leitura junta assim mesmo, sem pedido em dobro', new Set(ids).size === ids.length && ids.length === blob.leads.length + arqLinhas(d1).length - 1, { n: ids.length })
  t('  ...e a copia que esta na linha vence a do arquivo', d.leads.find((l) => String(l.id) === dupId).obs === 'copia velha na linha')
  t('a primeira gravacao conserta: linha canonica de novo, sem dobro', (await rmw(eA, () => {})) && !!confere(d1, 'apos consertar') && A._arqGenDe(cru(d1).data) >= 1)
  const r2 = cru(d1).data
  d1.__db.prepare('UPDATE dashboard_state SET data = ?, version = version + 1').run(r2.slice(0, -1) + ',"chave_nova":[1,2]}')
  A.__arqZera()
  const d3 = JSON.parse((await le(eA)).data)
  t('chave acrescentada por fora depois do _fim: le certo (caminho lento) e a chave nao se perde', Array.isArray(d3.chave_nova) && d3.leads.length === ids.length && (await rmw(eA, () => {})) && JSON.parse((await le(eB)).data).chave_nova.length === 2 && !!confere(d1, 'apos chave por fora'))
  d1.__db.prepare("INSERT INTO leads_arquivo (id, json, col, ts) VALUES ('podre', '{quebrado', 'Pago', 1)").run()
  const g = A._arqGenDe(cru(d1).data)
  d1.__db.prepare('UPDATE dashboard_state SET data = ?, version = version + 1').run(cru(d1).data.replace('{"_arq":' + g + ',', '{"_arq":' + (g + 1) + ','))
  A.__arqZera()
  let leu = null; try { leu = JSON.parse((await le(eA)).data) } catch (e) { leu = null }
  t('linha corrompida no arquivo e ignorada; o estado continua abrindo', !!leu && leu.leads.length === ids.length)
  d1.__db.prepare("DELETE FROM leads_arquivo WHERE id = 'podre'").run()
}

console.log('8. OPERACOES AO ACASO CONTRA UM ESTADO DE REFERENCIA (sem arquivo)')
{
  let seed = Number(process.env.SEMENTE || 20261012)
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const COLS = ['A Enviar', 'Enviado', 'Cobrança', 'Pago', 'Pagos', 'Cancelado', 'Devolvido', 'Frustrados', 'Rota de Entrega']
  const f = banco(); const fa = env(A, f), fb = env(B, f)
  A.__arqZera(); B.__arqZera()
  let ref = JSON.parse(ORIG)
  let proxId = 2000000000000, divergiu = ''
  const ops = { add: 0, edita: 0, move: 0, apaga: 0, outra: 0, cron: 0, frio: 0, velha: 0, volta: 0, massa: 0 }
  const N = Number(process.env.FUZZ || 600)
  for (let i = 0; i < N && !divergiu; i++) {
    const e = rnd() < 0.5 ? fa : fb, mod = e === fa ? A : B
    const x = rnd()
    const ids = ref.leads.map((l) => String(l.id))
    let muda = null
    if (x < 0.12) { const id = proxId++; const velho = rnd() < 0.7; const col = pick(COLS); const quando = new Date(AGORA - (velho ? 20 : 1) * 86400000).toISOString(); muda = (d) => { d.leads.unshift({ id, nome: 'Fuzz ' + id, col, spg: col.startsWith('Pag') ? 'Pago' : 'Pendente', vl: 197, hist: [{ from: '—', to: col, who: 'fuzz', time: quando }], comments: [] }) }; ops.add++ }
    else if (x < 0.40) { const id = pick(ids), v = 'obs ' + i, comHist = rnd() < 0.3; muda = (d) => { const l = d.leads.find((q) => String(q.id) === id); if (l) { l.obs = v; if (comHist) (l.hist = l.hist || []).push({ from: l.col, to: l.col, who: 'fuzz', time: '2026-09-01T00:00:00.000Z', note: 'n' + i }) } }; ops.edita++ }
    else if (x < 0.58) { const id = pick(ids), col = pick(COLS); muda = (d) => { const l = d.leads.find((q) => String(q.id) === id); if (l) { l.col = col; l.spg = col.startsWith('Pag') ? 'Pago' : 'Pendente' } }; ops.move++ }
    else if (x < 0.64) { const id = pick(ids); muda = (d) => { d.leads = d.leads.filter((q) => String(q.id) !== id) }; ops.apaga++ }
    else if (x < 0.74) { const k = pick(['notifs', 'gastos', 'fuzz_chave']); muda = (d) => { d[k] = (Array.isArray(d[k]) ? d[k] : []).concat([{ id: 'f' + i }]).slice(-200) }; ops.outra++ }
    else if (x < 0.86) { await mod._arqCron(e, { dias: 2 + Math.floor(rnd() * 9), lote: 1 + Math.floor(rnd() * 40) }); ops.cron++ }
    else if (x < 0.90) { mod.__arqZera(); ops.frio++ }
    else if (x < 0.94) {
      const row = await le(e); const d = JSON.parse(row.data); const id = pick(ids); const l = d.leads.find((q) => String(q.id) === id); if (l) { l.obs = 'NAO PODE GRAVAR'; l.col = pick(COLS) }
      const outro = e === fa ? fb : fa
      const mk = (dd) => { dd.fuzz_meio = i }
      await rmw(outro, mk); mk(ref)
      const r = await e.DB.prepare(UPD).bind(JSON.stringify(d), row.version + 1, 1, 'velha', row.version).run()
      if (r.meta.changes !== 0) divergiu = 'gravacao velha passou na op ' + i
      ops.velha++
    }
    else if (x < 0.97) {
      const row = await le(e); const mapa = row.__arq ? [...row.__arq.map.keys()] : []
      if (mapa.length) { const quais = new Set(mapa.filter(() => rnd() < 0.2).slice(0, 30)); if (quais.size) await e.DB.__arqGrava([row.data, row.version + 1, 1, 'volta', row.version], { voltar: quais }) }
      ops.volta++
    }
    else {
      const fora = new Set(ids.filter(() => rnd() < 0.02))
      if (fora.size > 2) {
        let arq = new Set(); try { arq = new Set(f.__db.prepare('SELECT id FROM leads_arquivo').all().map((r) => String(r.id))) } catch {}
        const nArqFora = [...fora].filter((id) => arq.has(id)).length
        const okk = await rmw(e, (d) => { d.leads = d.leads.filter((q) => !fora.has(String(q.id))) })
        if (okk) ref.leads = ref.leads.filter((q) => { const id = String(q.id); if (!fora.has(id)) return true; return arq.has(id) && nArqFora > 2 })
      }
      ops.massa++
    }
    if (muda) { const okk = await rmw(e, muda); if (okk) muda(ref); else divergiu = 'rmw nao gravou na op ' + i }
    const quem = rnd() < 0.5 ? fa : fb
    const d = JSON.parse((await le(quem)).data)
    const dif = mesmoConjunto(porId(d.leads), porId(ref.leads))
    if (dif) divergiu = 'pedidos divergem na op ' + i + ': ' + dif
    else if (d.leads.length !== ref.leads.length) divergiu = 'pedido em dobro na op ' + i
    else if (resto(d) !== resto(ref)) divergiu = 'resto do estado diverge na op ' + i
    else { const r = cru(f); const linhas = arqLinhas(f); const b = JSON.parse(r.data); const sb = new Set(b.leads.map((l) => String(l.id))); if (linhas.some((q) => sb.has(String(q.id)))) divergiu = 'pedido nos dois lugares na op ' + i; else if (linhas.some((q) => !TERM.has(JSON.parse(q.json).col))) divergiu = 'pedido aberto no arquivo na op ' + i }
  }
  const fim = confere(f, 'fuzz')
  t(N + ' operacoes (' + Object.entries(ops).map(([k, v]) => k + ' ' + v).join(', ') + '): leitura sempre igual a referencia', divergiu === '', divergiu)
  if (fim) console.log('     no fim: ' + ref.leads.length + ' pedidos (' + fim.nBlob + ' na linha, ' + fim.nArq + ' no arquivo), geracao ' + fim.gen + ', linha ' + fim.bytes + ' bytes')
}

console.log(`\n${ok} ok, ${falha} falha(s)`)
try { fs.unlinkSync(copia) } catch {}
process.exit(falha ? 1 : 0)
