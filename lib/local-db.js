// 本机 mcp-toolkit.db 操作（node:sqlite）。
// SSH 目标的自定义部署走远端 python 脚本写远端 db；本机目标没有远端环境，
// 直接用 node:sqlite 操作本机 ~/.docker/mcp/mcp-toolkit.db 的 working_set 表。
// 该库与 docker mcp CLI / gateway 共用，写入即加入 profile（需重启 gateway 生效）。

import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_DB = () => join(homedir(), '.docker', 'mcp', 'mcp-toolkit.db')

// 在 profile 的 working_set.servers 里追加/替换一个 entry（按 server name 去重）
export async function upsertServer({ profile, entry, dbPath = null }) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath || DEFAULT_DB())
  try {
    let row = null
    try {
      row = db.prepare('SELECT servers FROM working_set WHERE name = ?').get(profile)
    } catch (error) {
      if (/no such table/i.test(String(error && error.message || ''))) {
        throw new Error(`profile not found: ${profile}（working_set 表不存在，请先运行 docker mcp 初始化）`)
      }
      throw error
    }
    if (!row) {
      throw new Error(`profile not found: ${profile}`)
    }
    let servers = []
    try {
      servers = JSON.parse(row.servers || '[]')
    } catch {
      servers = []
    }
    const name = ((entry.snapshot || {}).server || {}).name || ''
    servers = servers.filter(
      (s) => ((s.snapshot || {}).server || {}).name !== name,
    )
    servers.push(entry)
    db.prepare('UPDATE working_set SET servers = ? WHERE name = ?').run(JSON.stringify(servers), profile)
    return { ok: true, name, total: servers.length }
  } finally {
    db.close()
  }
}

// 从 profile 移除一个 server（按 name）
export async function removeServer({ profile, name, dbPath = null }) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath || DEFAULT_DB())
  try {
    let row = null
    try {
      row = db.prepare('SELECT servers FROM working_set WHERE name = ?').get(profile)
    } catch (error) {
      if (/no such table/i.test(String(error && error.message || ''))) {
        throw new Error(`profile not found: ${profile}（working_set 表不存在，请先运行 docker mcp 初始化）`)
      }
      throw error
    }
    if (!row) throw new Error(`profile not found: ${profile}`)
    let servers = []
    try {
      servers = JSON.parse(row.servers || '[]')
    } catch {
      servers = []
    }
    const before = servers.length
    servers = servers.filter((s) => ((s.snapshot || {}).server || {}).name !== name)
    db.prepare('UPDATE working_set SET servers = ? WHERE name = ?').run(JSON.stringify(servers), profile)
    return { ok: true, removed: before - servers.length }
  } finally {
    db.close()
  }
}

export default { upsertServer, removeServer }
