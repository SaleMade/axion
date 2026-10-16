// Um D1 de mentira em cima do SQLite de verdade (node:sqlite): mesma API que o worker usa
// (prepare/bind/first/all/run + batch em transacao), mesma linguagem SQL. Conta as consultas.
import { DatabaseSync } from 'node:sqlite'

export function criaD1() {
  const db = new DatabaseSync(':memory:')
  const conta = { consultas: 0, lotes: 0, sql: [] }
  const ehLeitura = (sql) => /^\s*(select|pragma|with|explain)\b/i.test(sql)
  const mk = (sql, binds) => ({
    __sql: sql, __binds: binds,
    bind: (...b) => mk(sql, b),
    async first(col) { conta.consultas++; conta.sql.push(sql); const r = db.prepare(sql).get(...binds); if (r === undefined) return null; return col ? r[col] : { ...r } },
    async all() { conta.consultas++; conta.sql.push(sql); return { success: true, results: db.prepare(sql).all(...binds).map((r) => ({ ...r })), meta: {} } },
    async run() { conta.consultas++; conta.sql.push(sql); if (ehLeitura(sql)) return { success: true, results: db.prepare(sql).all(...binds).map((r) => ({ ...r })), meta: { changes: 0 } }; const i = db.prepare(sql).run(...binds); return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } } },
    async raw() { conta.consultas++; return db.prepare(sql).all(...binds).map((r) => Object.values(r)) },
  })
  const d1 = {
    prepare: (sql) => mk(sql, []),
    async batch(lista) {
      conta.lotes++
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of lista) {
          conta.consultas++; conta.sql.push(s.__sql)
          if (ehLeitura(s.__sql)) out.push({ success: true, results: db.prepare(s.__sql).all(...s.__binds).map((r) => ({ ...r })), meta: { changes: 0 } })
          else { const i = db.prepare(s.__sql).run(...s.__binds); out.push({ success: true, meta: { changes: Number(i.changes) } }) }
        }
        db.exec('COMMIT')
        return out
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
    async exec(sql) { db.exec(sql); return { count: 1 } },
    __db: db, __conta: conta,
  }
  return d1
}
