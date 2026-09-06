// Docker MCP Gateway 看板 Host 服务：经 SSH 在远端服务器执行 `docker mcp`
// 命令，聚合 profiles（已部署的 MCP）与 catalog（仓库的 MCP）快照，并
// 处理部署/移除等动作。catalog 全量 8MB，只在首次/手动刷新时拉取并精简
// 缓存；高频轮询只拉 profile + gateway 状态（KB 级）。

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SshService } from './ssh-service.js'
import { LocalExecService } from './local-exec.js'
import { CryptoStore } from './crypto-store.js'
import * as localDb from './local-db.js'

const CATALOG_REF = 'mcp/docker-mcp-catalog:latest'
const DEFAULT_POLL_MS = 8_000

function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

// 精简 catalog server（丢弃 tools 详情，只留列表/搜索需要的字段）。
function slimServer(entry) {
  const snap = entry && entry.snapshot && entry.snapshot.server ? entry.snapshot.server : {}
  const meta = snap.metadata || {}
  const tools = Array.isArray(snap.tools) ? snap.tools : []
  return {
    name: snap.name || '',
    title: snap.title || snap.name || '',
    description: snap.description || '',
    image: entry.image || snap.image || '',
    icon: snap.icon || '',
    readme: snap.readme || '',
    toolCount: tools.length,
    category: meta.category || '',
    pulls: meta.pulls || 0,
    stars: meta.stars || 0,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
  }
}

function slimProfileServer(s) {
  const snap = s && s.snapshot && s.snapshot.server ? s.snapshot.server : {}
  const remote = snap.remote || {}
  return {
    type: s.type || 'image',
    image: s.image || snap.image || '',
    name: snap.name || '',
    title: snap.title || snap.name || '',
    description: snap.description || '',
    endpoint: s.endpoint || remote.url || '',
    toolCount: Array.isArray(snap.tools) ? snap.tools.length : 0,
  }
}

export class McpGatewayBoardService {
  constructor({ config, configPath }) {
    this.config = config
    this.configPath = configPath
    this.crypto = new CryptoStore()
    // 多目标：targetId -> { id, name, type, ssh?, exec, creds }
    this.targets = new Map()
    this.activeTargetId = ''
    this.credsReady = null // Promise，凭据解密完成后 resolve
    this.snapshot = {
      connected: false,
      error: '',
      ssh: { connected: false, error: '' },
      target: null, // 当前目标公开信息
      targets: [], // 所有目标公开信息（供前端切换器）
      activeTargetId: '',
      catalog: null,
      catalogServers: [],
      profiles: [],
      servers: [],
      gateway: { running: false, pid: 0, port: 0 },
      containers: [],
      images: [],
      updatedAt: 0,
      config: {},
    }
    this.timer = null
    this.refreshing = false
    this.catalogRefreshing = false
    this._catalogPromise = null
    // 交互终端会话：sessionId -> { container, listeners: Set<fn(event)> }
    this.shellSessions = new Map()
  }

  start() {
    this.credsReady = this._prepareCreds()
      .catch(() => {})
      .then(() => {
        // 凭据解密完成（含明文迁移），用真实凭据重建目标执行器
        this._buildTargets()
        return this.refresh().catch(() => {})
      })
    this._buildTargets()
    this.refresh().catch(() => {})
    this._scheduleCatalogRefresh(true)
    const interval = Number(this.config.pollIntervalMs) || DEFAULT_POLL_MS
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {})
    }, Math.max(3000, interval))
    this.timer.unref?.()
  }

  // 解密所有 SSH 目标凭据：password/passphrase 在配置里以 DPAPI 密文存储（本地加密）。
  // 兼容迁移：发现旧明文 password 时自动加密重写配置（只写一次）。
  async _prepareCreds() {
    const targets = Array.isArray(this.config.targets) ? this.config.targets : []
    let changed = false
    for (const t of targets) {
      if (!t || t.type !== 'ssh') continue
      const sshCfg = t.ssh || {}
      if (sshCfg.password && sshCfg.password.length > 0) {
        const decrypted = await this.crypto.decrypt(sshCfg.password)
        if (decrypted === null && !sshCfg._migrated) {
          // 旧明文：加密后写回
          try {
            sshCfg.password = await this.crypto.encrypt(sshCfg.password)
            sshCfg._migrated = true
            changed = true
          } catch {
            /* 加密失败保持原样（仍能连） */
          }
        }
      }
      if (sshCfg.passphrase && sshCfg.passphrase.length > 0) {
        const decrypted = await this.crypto.decrypt(sshCfg.passphrase)
        if (decrypted === null && !sshCfg._migrated) {
          try {
            sshCfg.passphrase = await this.crypto.encrypt(sshCfg.passphrase)
            sshCfg._migrated = true
            changed = true
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (changed) this._persistConfig()
    // 解密后的凭据缓存到各 target
    this.creds = {}
    for (const t of targets) {
      if (!t || t.type !== 'ssh') continue
      const sshCfg = t.ssh || {}
      this.creds[t.id] = {
        password: sshCfg.password ? await this.crypto.decrypt(sshCfg.password) : '',
        passphrase: sshCfg.passphrase ? await this.crypto.decrypt(sshCfg.passphrase) : '',
      }
    }
  }

  // 从配置构建所有目标的执行器；activeTargetId 失效时回退到第一个。
  _buildTargets() {
    const targets = Array.isArray(this.config.targets) ? this.config.targets : []
    // 释放旧执行器（保留非当前目标已建的，避免重建）
    const keep = new Set(targets.map((t) => t.id))
    for (const [id, entry] of this.targets) {
      if (!keep.has(id)) {
        try {
          entry.exec.dispose()
        } catch {
          /* ignore */
        }
        this.targets.delete(id)
      }
    }
    for (const t of targets) {
      if (!t || !t.id) continue
      const existing = this.targets.get(t.id)
      if (existing && existing.type === t.type) {
        // SSH 目标：凭据可能刚解密，更新（SshService 惰性 start 时读取 this.ssh）
        if (t.type === 'ssh') {
          const decrypted = this._decryptedSsh(t)
          existing.ssh = { ...existing.ssh, ...decrypted }
          if (existing.exec) existing.exec.ssh = decrypted
        }
        continue
      }
      const entry = this._makeTarget(t)
      if (entry) this.targets.set(t.id, entry)
    }
    if (!this.activeTargetId || !this.targets.has(this.activeTargetId)) {
      // 优先用配置里的 activeTargetId（幂等：已同步时保持不变）
      const cfgActive = this.config.activeTargetId
      if (cfgActive && this.targets.has(cfgActive)) {
        this.activeTargetId = cfgActive
      } else {
        this.activeTargetId = targets.length > 0 ? targets[0].id : ''
      }
    }
  }

  _decryptedSsh(t) {
    const creds = this.creds || {}
    const c = creds[t.id] || { password: '', passphrase: '' }
    return {
      host: t.ssh.host,
      port: t.ssh.port,
      user: t.ssh.user,
      auth: t.ssh.auth || 'password',
      keyPath: t.ssh.keyPath || '',
      password: c.password,
      passphrase: c.passphrase,
    }
  }

  _makeTarget(t) {
    if (t.type === 'local') {
      return {
        id: t.id,
        name: t.name || '本机 Docker',
        type: 'local',
        dockerPath: t.dockerPath || '',
        exec: new LocalExecService({
          dockerPath: t.dockerPath || '',
          onEvent: (event) => this._onTargetEvent('local', event),
        }),
      }
    }
    if (t.type === 'ssh') {
      const sshCfg = this._decryptedSsh(t)
      const exec = new SshService({
        ssh: sshCfg,
        onEvent: (event) => this._onTargetEvent(t.id, event),
      })
      return { id: t.id, name: t.name || `${sshCfg.host || ''}`, type: 'ssh', ssh: sshCfg, exec }
    }
    return null
  }

  _onTargetEvent(targetId, event) {
    if (event.type === 'proc-exit' || event.type === 'proc-error') {
      const t = this.targets.get(targetId)
      if (t) {
        t.connected = false
        t.error = event.error || '执行器进程退出'
      }
      if (targetId === this.activeTargetId) {
        this.snapshot.ssh.connected = false
        this.snapshot.ssh.error = event.error || '执行器进程退出'
      }
    }
    // PTY 输出/退出事件 → 转发给对应会话的监听器
    if (event.type === 'pty-out' || event.type === 'pty-exit') {
      this._dispatchShellEvent(event)
    }
  }

  _active() {
    return this.targets.get(this.activeTargetId) || null
  }

  async _exec(cmd, timeoutMs) {
    const t = this._active()
    if (!t) throw new Error('未配置任何目标')
    const res = await t.exec.exec(cmd, timeoutMs)
    return res
  }

  async _execJson(cmd, timeoutMs = 60_000) {
    const res = await this._exec(cmd, timeoutMs)
    return parseJson(res.stdout)
  }

  // ---- 快照刷新（高频，轻量）----
  async refresh(force = false) {
    if (this.refreshing) {
      if (!force) return this.snapshot
      // 等待当前刷新完成，再强制刷一次
      while (this.refreshing) {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    this.refreshing = true
    try {
      // profile server ls 返回 [{id, name, servers: [...]}]（含完整 server 详情），
      // 一次命令同时拿到 profiles 与 servers，无需再单独调 profile list。
      const [profileServers, gateway, catMeta] = await Promise.all([
        this._execJson('docker mcp profile server ls --format json', 30_000),
        this._probeGateway(),
        this._execJson('docker mcp catalog list --format json', 30_000),
      ])

      const profileList = Array.isArray(profileServers) ? profileServers : []

      const slimProfiles = []
      const slimServers = []
      for (const p of profileList) {
        const pId = p.id || p.name || ''
        const pservers = Array.isArray(p.servers) ? p.servers : []
        const slimPservers = pservers.map(slimProfileServer)
        slimProfiles.push({
          id: pId,
          name: p.name || p.id || '',
          serverCount: slimPservers.length,
          servers: slimPservers,
        })
        for (const s of pservers) {
          const snap = s && s.snapshot && s.snapshot.server ? s.snapshot.server : {}
          const remote = snap.remote || {}
          slimServers.push({
            profile: pId,
            type: s.type || 'image',
            name: snap.name || '',
            title: snap.title || snap.name || '',
            image: s.image || snap.image || '',
            description: snap.description || '',
            endpoint: s.endpoint || remote.url || '',
            toolCount: Array.isArray(snap.tools) ? snap.tools.length : 0,
          })
        }
      }

      const catArr = Array.isArray(catMeta) ? catMeta : []
      const catRef = catArr[0] || null
      this.snapshot.catalog = catRef
        ? { ref: catRef.ref || CATALOG_REF, title: catRef.title || '', digest: catRef.digest || '' }
        : null

      this.snapshot.profiles = slimProfiles
      this.snapshot.servers = slimServers
      this.snapshot.gateway = gateway
      const active = this._active()
      this.snapshot.target = this._targetPublic(active)
      this.snapshot.targets = this._targetsPublic()
      this.snapshot.activeTargetId = this.activeTargetId
      this.snapshot.ssh.connected = true
      this.snapshot.ssh.error = ''
      this.snapshot.connected = true
      this.snapshot.error = ''
      this.snapshot.updatedAt = Date.now()
      this.snapshot.config = this._publicConfig()
    } catch (error) {
      this.snapshot.connected = false
      this.snapshot.error = error instanceof Error ? error.message : String(error)
      this.snapshot.ssh.connected = false
      this.snapshot.ssh.error = this.snapshot.error
      this.snapshot.target = this._targetPublic(this._active())
      this.snapshot.targets = this._targetsPublic()
      this.snapshot.activeTargetId = this.activeTargetId
      this.snapshot.updatedAt = Date.now()
    } finally {
      this.refreshing = false
    }
    return this.snapshot
  }

  // 目标的公开信息（不含密钥）
  _targetPublic(t) {
    if (!t) return null
    return {
      id: t.id,
      name: t.name || '',
      type: t.type,
      connected: Boolean(t.exec && t.exec.connected),
      error: t.exec && t.exec.lastError ? t.exec.lastError : '',
    }
  }

  _targetsPublic() {
    const list = []
    for (const [id, t] of this.targets) {
      list.push(this._targetPublic(t))
    }
    return list
  }

  async _probeGateway() {
    const t = this._active()
    if (!t) return { running: false, pid: 0, port: 0, profile: '' }
    if (t.type === 'local') return this._probeGatewayLocal()
    try {
      const res = await this._exec(
        "ps -eo pid,args | grep '[d]ocker-mcp.*gateway' | head -5; echo '---PORTS---'; ss -tlnp 2>/dev/null | grep -E 'docker-mcp' | head -10",
        20_000,
      )
      const text = res.stdout || ''
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      const procs = lines.filter((l) => l.includes('gateway') && !l.startsWith('---'))
      const ports = lines.filter((l) => l.includes(':') && l.includes('docker-mcp'))
      let pid = 0
      let port = 0
      let profile = ''
      for (const p of procs) {
        const m = p.match(/^\s*(\d+)\s/)
        if (m) pid = Number(m[1])
        const pm = p.match(/--profile\s+([\w.-]+)/)
        if (pm) profile = pm[1]
      }
      for (const pt of ports) {
        const m = pt.match(/:(\d+)\s/)
        if (m) port = Number(m[1])
      }
      return { running: procs.length > 0, pid, port, profile }
    } catch {
      return { running: false, pid: 0, port: 0 }
    }
  }

  // 本机 Windows：tasklist 找 docker-mcp 进程 + netstat 找监听端口
  async _probeGatewayLocal() {
    const run = async (cmd) => {
      const { execFile } = await import('node:child_process')
      const parts = cmd.split(/\s+/).filter(Boolean)
      if (parts.length === 0) return ''
      return new Promise((resolve) => {
        execFile(parts[0], parts.slice(1), { windowsHide: true }, (error, stdout) => {
          resolve(error ? '' : String(stdout || ''))
        })
      })
    }
    try {
      const text = await run('tasklist /FI "IMAGENAME eq docker-mcp.exe" /FO CSV /NH')
      const running = /docker-mcp\.exe/i.test(text)
      let pid = 0
      let port = 0
      const m = text.match(/docker-mcp\.exe","(\d+)/i)
      if (m) pid = Number(m[1])
      if (pid > 0) {
        // 进程存在：netstat 里找该 PID 的 LISTENING 端口（docker-mcp gateway 的监听端口）
        try {
          const net = await run('netstat -ano')
          const pidStr = String(pid)
          const lines = net.split('\n').filter((l) => /LISTENING/.test(l) && l.trim().endsWith(pidStr))
          const first = lines[0] || ''
          const pm = first.match(/[0-9.]+:(\d+)/)
          if (pm) port = Number(pm[1])
        } catch {
          /* ignore */
        }
      }
      return { running, pid, port, profile: '' }
    } catch {
      return { running: false, pid: 0, port: 0 }
    }
  }

  // ---- catalog 拉取（低频，重）----
  _scheduleCatalogRefresh(immediate = false) {
    if (immediate) void this.refreshCatalog()
  }

  async refreshCatalog(force = false) {
    if (this.catalogRefreshing) return this._catalogPromise
    this.catalogRefreshing = true
    this._catalogPromise = this._doRefreshCatalog(force).finally(() => {
      this.catalogRefreshing = false
      this._catalogPromise = null
    })
    return this._catalogPromise
  }

  async _doRefreshCatalog(force) {
    try {
      const data = await this._execJson(
        `docker mcp catalog server ls ${CATALOG_REF} --format json`,
        180_000,
      )
      const entries = data && Array.isArray(data.servers) ? data.servers : []
      const slim = entries.map(slimServer).filter((s) => s.name !== '')
      this.snapshot.catalogServers = slim
      if (this.snapshot.catalog) this.snapshot.catalog.serverCount = slim.length
      this.snapshot.catalogUpdatedAt = Date.now()
      return { ok: true, count: slim.length }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ---- 动作 ----
  async apply(action) {
    const kind = action && action.kind
    switch (kind) {
      case 'set-active-target':
        return this._setActiveTarget(action)
      case 'deploy':
        return this._deploy(action)
      case 'deploy-custom':
        return this._deployCustom(action)
      case 'remove':
        return this._remove(action)
      case 'create-profile':
        return this._createProfile(action)
      case 'remove-profile':
        return this._removeProfile(action)
      case 'refresh-catalog':
        return this.refreshCatalog(true)
      case 'gateway-start':
        return this._gatewayStart(action)
      case 'gateway-stop':
        return this._gatewayStop()
      case 'gateway-restart':
        return this._gatewayRestart(action)
      case 'set-config':
        return this._setConfig(action)
      case 'docker':
        return this._docker(action)
      case 'refresh':
        await this.refresh(true)
        return { ok: true, snapshot: this.snapshot }
      default:
        throw new Error(`未知动作: ${kind}`)
    }
  }

  async _setActiveTarget(action) {
    const id = String(action.id || '').trim()
    if (!this.targets.has(id)) throw new Error(`目标不存在: ${id}`)
    this.activeTargetId = id
    this.config.activeTargetId = id
    this._persistConfig()
    // 关闭所有交互终端（目标切换后旧会话失效）
    for (const session of [...this.shellSessions.keys()]) {
      try {
        await this.closeShell(session)
      } catch {
        /* ignore */
      }
    }
    await this.refresh(true)
    this._scheduleCatalogRefresh(true)
    this.snapshot.config = this._publicConfig()
    return { ok: true, snapshot: this.snapshot }
  }

  async _deploy(action) {
    const name = (action.name || '').trim()
    const profile = (action.profile || '').trim()
    if (name === '') throw new Error('server 名不能为空')
    if (profile === '') throw new Error('请先创建/选择 profile')
    // profile 参数是 profile-id（前端只传已存在的 profile id；name 会被 slugify，故不能用 name 当 id）
    const res = await this._exec(
      `docker mcp profile server add ${this._q(profile)} --server catalog://${CATALOG_REF}/${this._q(name)}`,
      120_000,
    )
    if (res.exit !== 0) throw new Error((res.stdout || res.stderr || '').trim().slice(0, 400) || `部署失败 exit=${res.exit}`)
    await this.refresh(true)
    return { ok: true, output: (res.stdout || res.stderr || '').trim().slice(0, 500), snapshot: this.snapshot }
  }

  // 自定义部署：绕过 CLI（docker:// 要求 self-describing 镜像，file:// 格式不稳），
  // 直接写远端 working_set（SQLite）——CLI 与 gateway 都读这个库，写入即加入 profile；
  // gateway 启动时加载，故需重启 gateway 生效（前端会提示/提供重启）。
  async _deployCustom(action) {
    const profile = (action.profile || '').trim()
    const type = action.type === 'image' ? 'image' : 'remote'
    const name = (action.name || '').trim()
    if (profile === '') throw new Error('请先创建/选择 profile')
    if (name === '') throw new Error('server 名称不能为空')

    let entry
    if (type === 'remote') {
      const url = (action.url || '').trim()
      // gateway 安全策略硬性要求 https（http remote 会被拒绝加载）
      if (!/^https:\/\/\S+$/i.test(url)) throw new Error('远端 MCP URL 必须为 https:// 开头（gateway 安全策略拒绝 http）')
      entry = {
        type: 'remote',
        secrets: 'default',
        tools: null,
        endpoint: url,
        snapshot: {
          server: {
            name,
            type: 'remote',
            image: '',
            description: action.description || '',
            title: action.title || name,
            remote: { url, transport_type: action.transport === 'sse' ? 'sse' : 'streamable-http' },
          },
        },
      }
    } else {
      const image = (action.image || '').trim()
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/.test(image) || !image.includes(':')) {
        throw new Error('镜像名格式不正确（如 mcp/sqlite:latest 或 my-reg/mcp:1.0）')
      }
      entry = {
        type: 'image',
        secrets: 'default',
        tools: null,
        image,
        snapshot: {
          server: {
            name,
            type: 'server',
            image,
            description: action.description || '',
            title: action.title || name,
            remote: {},
            command: Array.isArray(action.command) ? action.command : [],
            volumes: Array.isArray(action.volumes) ? action.volumes : [],
          },
        },
      }
      // 可选：部署前先拉镜像（远端 docker pull，可能因网络失败；失败则中止写入）
      if (action.pull === true) {
        const pullRes = await this._exec(`docker pull ${this._q(image)}`, 300_000)
        if (pullRes.exit !== 0) {
          throw new Error(`拉取镜像失败：${(pullRes.stdout || pullRes.stderr || '').trim().slice(0, 300)}`)
        }
      }
    }

    const active = this._active()
    if (!active) throw new Error('未配置任何目标')

    // 本机目标：直接 node:sqlite 写本机 mcp-toolkit.db（docker mcp CLI/gateway 同库）
    if (active.type === 'local') {
      try {
        const r = await localDb.upsertServer({ profile, entry })
        await this.refresh(true)
        return { ok: true, output: `OK name=${r.name} total=${r.total}`, needsRestart: true, snapshot: this.snapshot }
      } catch (error) {
        throw new Error(`本机写入 profile 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 用 base64 把整个 python 脚本传到远端执行，避免 shell 转义问题。
    const script = [
      'import sqlite3, json, base64, os, sys',
      "payload = json.loads(base64.b64decode('%B64%').decode())",
      "profile = payload.get('profile','')",
      'entry = payload.get(\'entry\')',
      "db_path = os.path.expanduser('~/.docker/mcp/mcp-toolkit.db')",
      'conn = sqlite3.connect(db_path)',
      "row = conn.execute('SELECT servers FROM working_set WHERE name=?', (profile,)).fetchone()",
      'if row is None:',
      "    print('ERR: profile not found: ' + profile); sys.exit(1)",
      'servers = json.loads(row[0])',
      "name = (entry.get('snapshot') or {}).get('server', {}).get('name') or ''",
      "servers = [s for s in servers if ((s.get('snapshot') or {}).get('server', {}).get('name') or '') != name]",
      'servers.append(entry)',
      "conn.execute('UPDATE working_set SET servers=? WHERE name=?', (json.dumps(servers), profile))",
      'conn.commit()',
      "print('OK name=%s total=%d' % (name, len(servers)))",
    ].join('\n')
    const scriptB64 = Buffer.from(script.replace('%B64%', Buffer.from(JSON.stringify({ profile, entry })).toString('base64'))).toString('base64')
    const cmd = `echo '${scriptB64}' | base64 -d > /tmp/mcpgw-dc.py && python3 /tmp/mcpgw-dc.py; rc=$?; rm -f /tmp/mcpgw-dc.py; exit $rc`
    const res = await this._exec(cmd, 60_000)
    if (res.exit !== 0) {
      throw new Error((res.stdout || res.stderr || '').trim().slice(0, 400) || `写入 profile 失败 exit=${res.exit}`)
    }
    await this.refresh(true)
    return {
      ok: true,
      output: (res.stdout || res.stderr || '').trim().slice(0, 500),
      needsRestart: true,
      snapshot: this.snapshot,
    }
  }

  // 重启 gateway：停掉现有实例，用其原 profile/port（缺省 taskagent:8000）带
  // --verify-signatures=false 重启（镜像签名验证需访问被墙的 Docker Hub CDN）。
  async _gatewayRestart(action) {
    const running = this.snapshot.gateway || {}
    const profile = (action.profile || '').trim() || running.profile || 'taskagent'
    const port = Number(action.port) || running.port || 8000
    const active = this._active()
    if (active && active.type === 'local') {
      await this._gatewayStop()
      return this._gatewayStartLocal(profile, port)
    }
    const cmd =
      `pkill -f '[d]ocker-mcp.*gateway' 2>/dev/null; sleep 2; ` +
      `nohup docker mcp gateway run --profile ${this._q(profile)} --transport streaming --port ${port} ` +
      `--allow-unauthenticated --watch --verify-signatures=false ` +
      `> /tmp/mcp-gateway.log 2>&1 & echo RESTARTED`
    const res = await this._exec(cmd, 20_000)
    await this.refresh(true)
    return { ok: res.exit === 0, output: (res.stdout || res.stderr || '').trim().slice(0, 300), snapshot: this.snapshot }
  }

  // ---- docker 容器管理（经 SSH 执行远端 docker CLI）----
  // op 白名单 + 参数白名单正则，杜绝 shell 注入；高危变更操作由前端二次确认。
  static DOCKER_OPS = {
    ps: { change: false, json: true, jsonMode: 'lines', timeout: 30_000 },
    images: { change: false, json: true, jsonMode: 'lines', timeout: 30_000 },
    inspect: { change: false, json: true, jsonMode: 'single', timeout: 30_000 },
    stats: { change: false, json: false, timeout: 30_000 },
    logs: { change: false, json: false, timeout: 30_000 },
    start: { change: true, json: false, timeout: 60_000 },
    stop: { change: true, json: false, timeout: 60_000 },
    restart: { change: true, json: false, timeout: 60_000 },
    rm: { change: true, json: false, timeout: 60_000 },
    pull: { change: true, json: false, timeout: 300_000 },
    run: { change: true, json: false, timeout: 120_000 },
    build: { change: true, json: false, timeout: 600_000 },
    load: { change: true, json: false, timeout: 300_000 },
    prune: { change: true, json: false, timeout: 60_000 },
  }

  static _safeId(v) {
    return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v) ? v : ''
  }

  static _safeImage(v) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(v) ? v : ''
  }

  // 远端路径安全校验：仅允许常见路径字符（含 ~ / . - _ :），禁止空格/分号/引号/$ 等注入字符
  static _safePath(v) {
    return /^[a-zA-Z0-9_./~:@-]+$/.test(v) ? v : ''
  }

  // 端口映射校验：如 8080:80、127.0.0.1:8080:80、8080/udp
  static _safePort(v) {
    return /^[0-9a-zA-Z.,:/[\]-]+$/.test(v) ? v : ''
  }

  // 环境变量校验：KEY=VALUE（KEY 须字母开头，VALUE 限安全字符）
  static _safeEnv(v) {
    return /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.,:/@+-]+$/.test(v) ? v : ''
  }

  // 卷挂载校验：/host:/container[:ro|:rw]
  static _safeVolume(v) {
    return /^[A-Za-z0-9_./:~-]+:[A-Za-z0-9_./:~-]+(:[a-z]+)?$/.test(v) ? v : ''
  }

  // 容器命令 token 校验：单 token 允许字母数字 _ . / : - =
  static _safeToken(v) {
    return /^[A-Za-z0-9_./:=@+-]+$/.test(v) ? v : ''
  }

  async _docker(action) {
    const op = (action.op || '').trim()
    const spec = McpGatewayBoardService.DOCKER_OPS[op]
    if (!spec) throw new Error(`不支持的 docker 操作: ${op}`)
    const targets = Array.isArray(action.targets) ? action.targets : []
    if (targets.length === 0 && !['ps', 'images', 'prune'].includes(op)) throw new Error('缺少目标（容器名/ID 或镜像名）')

    let cmd
    switch (op) {
      case 'ps':
        cmd = "docker ps -a --format json"
        break
      case 'images':
        cmd = "docker images --format json"
        break
      case 'inspect': {
        const id = McpGatewayBoardService._safeId(String(targets[0] || ''))
        if (!id) throw new Error('容器 ID 非法')
        cmd = `docker inspect ${this._q(id)}`
        break
      }
      case 'stats': {
        const id = McpGatewayBoardService._safeId(String(targets[0] || ''))
        if (!id) throw new Error('容器 ID 非法')
        cmd = `docker stats --no-stream ${this._q(id)}`
        break
      }
      case 'logs': {
        const id = McpGatewayBoardService._safeId(String(targets[0] || ''))
        if (!id) throw new Error('容器 ID 非法')
        const tail = Number(action.tail) || 100
        cmd = `docker logs --tail ${tail} ${this._q(id)}`
        break
      }
      case 'start':
      case 'stop':
      case 'restart':
      case 'rm': {
        const ids = targets.map((t) => McpGatewayBoardService._safeId(String(t))).filter(Boolean)
        if (ids.length === 0) throw new Error('容器 ID 非法')
        const flag = op === 'rm' ? (action.force ? '-f ' : '') : ''
        cmd = `docker ${op} ${flag}${ids.map((i) => this._q(i)).join(' ')}`
        break
      }
      case 'pull': {
        const img = McpGatewayBoardService._safeImage(String(targets[0] || ''))
        if (!img) throw new Error('镜像名非法')
        cmd = `docker pull ${this._q(img)}`
        break
      }
      case 'build': {
        // targets[0] = 镜像名:tag；action.context = 构建上下文（远端路径）；action.dockerfile 可选
        const img = McpGatewayBoardService._safeImage(String(targets[0] || ''))
        if (!img) throw new Error('镜像名非法')
        const context = McpGatewayBoardService._safePath(String(action.context || ''))
        if (context === '') throw new Error('构建上下文路径非法（仅允许字母数字 _ . / ~ : -）')
        const dockerfile = McpGatewayBoardService._safePath(String(action.dockerfile || ''))
        const dfArg = dockerfile !== '' ? `-f ${this._q(dockerfile)} ` : ''
        cmd = `docker build -t ${this._q(img)} ${dfArg}${this._q(context)}`
        break
      }
      case 'load': {
        // targets[0] = 远端 tar 文件路径（docker save 产物）
        const path = McpGatewayBoardService._safePath(String(targets[0] || ''))
        if (path === '') throw new Error('镜像文件路径非法（仅允许字母数字 _ . / ~ : -）')
        cmd = `docker load -i ${this._q(path)}`
        break
      }
      case 'run': {
        // targets[0] = 镜像名；action.name/ports/env/volumes/cmd 可选
        const img = McpGatewayBoardService._safeImage(String(targets[0] || ''))
        if (!img) throw new Error('镜像名非法')
        const parts = ['docker', 'run', '-d']
        const nameRaw = String(action.name || '')
        if (nameRaw !== '') {
          const name = McpGatewayBoardService._safeId(nameRaw)
          if (name === '') throw new Error('容器名非法（仅允许字母数字 _ . -）')
          parts.push('--name', this._q(name))
        }
        const ports = Array.isArray(action.ports) ? action.ports.map((p) => McpGatewayBoardService._safePort(String(p))).filter(Boolean) : []
        if (ports.length !== (Array.isArray(action.ports) ? action.ports.length : 0)) throw new Error('端口映射格式非法（如 8080:80）')
        for (const p of ports) parts.push('-p', this._q(p))
        const envs = Array.isArray(action.env) ? action.env.map((e) => McpGatewayBoardService._safeEnv(String(e))).filter(Boolean) : []
        if (envs.length !== (Array.isArray(action.env) ? action.env.length : 0)) throw new Error('环境变量格式非法（需 KEY=VALUE）')
        for (const e of envs) parts.push('-e', this._q(e))
        const vols = Array.isArray(action.volumes) ? action.volumes.map((v) => McpGatewayBoardService._safeVolume(String(v))).filter(Boolean) : []
        if (vols.length !== (Array.isArray(action.volumes) ? action.volumes.length : 0)) throw new Error('卷挂载格式非法（如 /host:/container）')
        for (const v of vols) parts.push('-v', this._q(v))
        parts.push(this._q(img))
        const cmdTokens = Array.isArray(action.cmd) ? action.cmd.map((t) => McpGatewayBoardService._safeToken(String(t))).filter(Boolean) : []
        if (cmdTokens.length !== (Array.isArray(action.cmd) ? action.cmd.length : 0)) throw new Error('命令参数含非法字符')
        for (const t of cmdTokens) parts.push(this._q(t))
        cmd = parts.join(' ')
        break
      }
      case 'prune':
        cmd = 'docker container prune -f'
        break
    }

    const res = await this._exec(cmd, spec.timeout)
    const raw = (res.stdout || '').trim()
    if (spec.json) {
      let parsed = []
      if (raw !== '') {
        if (spec.jsonMode === 'single') {
          // 单块 JSON（如 docker inspect 输出整体是 JSON 数组）
          try {
            parsed = JSON.parse(raw)
            if (!Array.isArray(parsed)) parsed = [parsed]
          } catch {
            parsed = []
          }
        } else {
          // docker --format json 输出为「每行一个 JSON 对象」（非数组），逐行解析
          for (const line of raw.split('\n')) {
            if (line.trim() === '') continue
            try {
              parsed.push(JSON.parse(line))
            } catch {
              /* 跳过非 JSON 行 */
            }
          }
        }
      }
      if (parsed.length > 0 || raw === '') {
        if (op === 'ps') this.snapshot.containers = parsed
        if (op === 'images') this.snapshot.images = parsed
        return { ok: true, data: parsed, raw, snapshot: this.snapshot }
      }
    }
    const output = raw.slice(0, 5000) || (res.stderr || '').trim().slice(0, 500)
    if (spec.change) {
      if (op === 'build' || op === 'load' || op === 'pull') await this._refreshImages()
      else await this._refreshContainers()
    }
    return { ok: res.exit === 0, op, output, snapshot: this.snapshot }
  }

  async _refreshImages() {
    try {
      const res = await this._exec("docker images --format json", 30_000)
      const raw = (res.stdout || '').trim()
      const parsed = []
      if (raw !== '') {
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          try {
            parsed.push(JSON.parse(line))
          } catch {
            /* ignore */
          }
        }
      }
      this.snapshot.images = parsed
    } catch {
      /* ignore */
    }
  }

  async _refreshContainers() {
    try {
      const res = await this._exec("docker ps -a --format json", 30_000)
      const raw = (res.stdout || '').trim()
      const parsed = []
      if (raw !== '') {
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          try {
            parsed.push(JSON.parse(line))
          } catch {
            /* ignore */
          }
        }
      }
      this.snapshot.containers = parsed
    } catch {
      /* ignore */
    }
  }

  // ---- 交互式容器终端（docker exec -it）----

  _dispatchShellEvent(event) {
    const session = event.session
    if (!session) return
    const entry = this.shellSessions.get(session)
    if (!entry) return
    if (event.type === 'pty-exit') {
      // 会话结束：通知监听器并清理
      for (const fn of entry.listeners) {
        try {
          fn({ type: 'exit', session, exit: event.exit })
        } catch {
          /* ignore */
        }
      }
      this.shellSessions.delete(session)
      return
    }
    // pty-out
    for (const fn of entry.listeners) {
      try {
        fn({ type: 'data', session, data: event.data })
      } catch {
        /* ignore */
      }
    }
  }

  async openShell(containerId, shell = 'sh') {
    const active = this._active()
    if (!active) throw new Error('未配置任何目标')
    if (active.type !== 'ssh') throw new Error('交互终端仅支持 SSH 目标（本机目标无 PTY）')
    const id = McpGatewayBoardService._safeId(String(containerId || ''))
    if (id === '') throw new Error('容器 ID 非法')
    const sh = McpGatewayBoardService._safeToken(String(shell || 'sh')) || 'sh'
    const cmd = `docker exec -it ${this._q(id)} ${sh}`
    const res = await active.exec.openPty(cmd, 30_000)
    const session = res.session || ''
    if (session === '') throw new Error('会话未创建')
    this.shellSessions.set(session, { container: id, listeners: new Set() })
    return { session, container: id }
  }

  writeShell(session, data) {
    const active = this._active()
    if (!active) throw new Error('未配置任何目标')
    if (active.type !== 'ssh') throw new Error('交互终端仅支持 SSH 目标')
    const s = String(session || '')
    if (!this.shellSessions.has(s)) throw new Error('会话不存在')
    return active.exec.writePty(s, String(data ?? ''))
  }

  resizeShell(session, cols, rows) {
    const active = this._active()
    if (!active) throw new Error('未配置任何目标')
    if (active.type !== 'ssh') throw new Error('交互终端仅支持 SSH 目标')
    const s = String(session || '')
    if (!this.shellSessions.has(s)) throw new Error('会话不存在')
    return active.exec.resizePty(s, Number(cols) || 120, Number(rows) || 32)
  }

  async closeShell(session) {
    const active = this._active()
    const s = String(session || '')
    if (this.shellSessions.has(s) && active && active.type === 'ssh') {
      try {
        await active.exec.closePty(s)
      } catch {
        /* ignore */
      }
      this.shellSessions.delete(s)
    } else if (this.shellSessions.has(s)) {
      this.shellSessions.delete(s)
    }
    return { ok: true }
  }

  // 订阅会话事件（SSE 流用），返回取消函数
  subscribeShell(session, listener) {
    const s = String(session || '')
    const entry = this.shellSessions.get(s)
    if (!entry) throw new Error('会话不存在')
    entry.listeners.add(listener)
    return () => {
      const e = this.shellSessions.get(s)
      if (e) e.listeners.delete(listener)
    }
  }

  async _remove(action) {    const name = (action.name || '').trim()
    const profile = (action.profile || '').trim()
    if (name === '') throw new Error('server 名不能为空')
    if (profile === '') throw new Error('请指定 profile')
    const active = this._active()
    if (active && active.type === 'local') {
      try {
        const r = await localDb.removeServer({ profile, name })
        await this.refresh(true)
        return { ok: true, output: `removed=${r.removed}`, snapshot: this.snapshot }
      } catch (error) {
        throw new Error(`本机移除失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const res = await this._exec(
      `docker mcp profile server remove ${this._q(profile)} --name ${this._q(name)}`,
      60_000,
    )
    if (res.exit !== 0) throw new Error((res.stdout || res.stderr || '').trim().slice(0, 400) || `移除失败 exit=${res.exit}`)
    await this.refresh(true)
    return { ok: true, output: (res.stdout || res.stderr || '').trim().slice(0, 500), snapshot: this.snapshot }
  }

  async _createProfile(action) {
    const name = (action.name || '').trim()
    if (name === '') throw new Error('profile 名不能为空')
    const res = await this._exec(`docker mcp profile create --name ${this._q(name)}`, 60_000)
    if (res.exit !== 0) throw new Error((res.stdout || res.stderr || '').trim().slice(0, 400) || `创建失败 exit=${res.exit}`)
    // 直接查 profile list 拿真实 id（name 会被 slugify，且避免与后台 refresh 竞态）
    let realId = name
    try {
      const list = await this._execJson('docker mcp profile list --format json', 30_000)
      const arr = Array.isArray(list) ? list : []
      const found = arr.find((p) => p.name === name) || arr.find((p) => p.id === name) || arr[arr.length - 1]
      if (found) realId = found.id || found.name || name
    } catch {
      /* ignore */
    }
    await this.refresh(true)
    return {
      ok: true,
      output: (res.stdout || res.stderr || '').trim().slice(0, 500),
      profileId: realId,
      snapshot: this.snapshot,
    }
  }

  async _removeProfile(action) {
    const id = (action.id || '').trim()
    if (id === '') throw new Error('profile id 不能为空')
    const res = await this._exec(`docker mcp profile remove ${this._q(id)}`, 60_000)
    if (res.exit !== 0) throw new Error((res.stdout || res.stderr || '').trim().slice(0, 400) || `删除失败 exit=${res.exit}`)
    await this.refresh(true)
    return { ok: true, output: (res.stdout || res.stderr || '').trim().slice(0, 500), snapshot: this.snapshot }
  }

  async _gatewayStart(action) {
    const profile = (action.profile || '').trim() || 'default'
    const port = Number(action.port) || 8080
    const active = this._active()
    if (active && active.type === 'local') {
      // 本机：spawn docker-mcp.exe gateway run（Windows）
      return this._gatewayStartLocal(profile, port)
    }
    const cmd =
      `nohup docker mcp gateway run --profile ${this._q(profile)} --port ${port} --transport streaming ` +
      `> /tmp/mcp-gateway.log 2>&1 & echo STARTED`
    const res = await this._exec(cmd, 20_000)
    await this.refresh(true)
    return { ok: res.exit === 0, output: (res.stdout || res.stderr || '').trim().slice(0, 300), snapshot: this.snapshot }
  }

  // 本机 gateway：spawn docker-mcp.exe gateway run（detached），把 pid 记录到目标。
  async _gatewayStartLocal(profile, port) {
    const active = this._active()
    const exe = active.exec._gatewayExe()
    const { spawn } = await import('node:child_process')
    const child = spawn(
      exe,
      ['gateway', 'run', '--profile', profile, '--port', String(port), '--transport', 'streaming'],
      {
        windowsHide: true,
        detached: false,
        stdio: 'ignore',
        env: { ...process.env, DOCKER_MCP_IN_CONTAINER: '1' },
      },
    )
    active.exec.gatewayProc = child
    child.unref?.()
    await new Promise((r) => setTimeout(r, 2500))
    await this.refresh(true)
    return {
      ok: true,
      output: `已启动本机 gateway（profile=${profile} port=${port} pid=${child.pid || 0}）`,
      snapshot: this.snapshot,
    }
  }

  async _gatewayStop() {
    const active = this._active()
    if (active && active.type === 'local') {
      const { execFile } = await import('node:child_process')
      const killed = await new Promise((resolve) => {
        execFile('taskkill', ['/IM', 'docker-mcp.exe', '/F'], { windowsHide: true }, (error, stdout) => {
          resolve(error ? String(stdout || '').trim() : String(stdout || '').trim())
        })
      })
      active.exec._stopGatewayProcess()
      await this.refresh(true)
      return { ok: true, output: killed || 'STOPPED', snapshot: this.snapshot }
    }
    const res = await this._exec(
      "pkill -f '[d]ocker-mcp.*gateway' 2>/dev/null; sleep 1; ss -tlnp 2>/dev/null | grep -E 'docker-mcp' || echo STOPPED",
      20_000,
    )
    await this.refresh(true)
    return { ok: true, output: (res.stdout || res.stderr || '').trim().slice(0, 300), snapshot: this.snapshot }
  }

  async _setConfig(action) {
    const patch = {}
    if (action.pollIntervalMs !== undefined) patch.pollIntervalMs = Number(action.pollIntervalMs) || DEFAULT_POLL_MS
    // 兼容旧版：action.ssh 更新「第一个 SSH 目标」的配置
    if (action.ssh && typeof action.ssh === 'object') {
      const targets = Array.isArray(this.config.targets) ? this.config.targets : []
      const sshTarget = targets.find((t) => t.type === 'ssh') || targets[0]
      if (sshTarget && sshTarget.type === 'ssh') {
        const next = { ...(sshTarget.ssh || {}), ...action.ssh }
        if (typeof next.password === 'string' && next.password !== '') {
          next.password = await this.crypto.encrypt(next.password)
        } else if (next.password === '') {
          delete next.password
        }
        if (typeof next.passphrase === 'string' && next.passphrase !== '') {
          next.passphrase = await this.crypto.encrypt(next.passphrase)
        } else if (next.passphrase === '') {
          delete next.passphrase
        }
        if (typeof next.keyPath === 'string' && next.keyPath.trim() === '') delete next.keyPath
        sshTarget.ssh = next
        this._persistConfig()
        await this._prepareCreds()
        this._buildTargets()
      }
    }
    // targets 增删改：action.targets = [{ id, name, type, ssh?, dockerPath? }]（完整列表）
    if (Array.isArray(action.targets)) {
      const cleaned = []
      for (const raw of action.targets) {
        if (!raw || typeof raw !== 'object') continue
        const id = String(raw.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '')
        if (id === '') continue
        const type = raw.type === 'local' ? 'local' : raw.type === 'ssh' ? 'ssh' : ''
        if (type === '') continue
        const item = { id, name: String(raw.name || '').trim() || id, type }
        if (type === 'local') {
          item.dockerPath = String(raw.dockerPath || '').trim()
        } else {
          const sshRaw = raw.ssh && typeof raw.ssh === 'object' ? raw.ssh : {}
          // 复用旧目标里未改动的加密凭据：若新值等于已存密文或为空，保留原值
          const prev = this._findTargetConfig(id)
          const prevSsh = prev && prev.type === 'ssh' ? prev.ssh : {}
          let password = prevSsh.password || ''
          if (typeof sshRaw.password === 'string' && sshRaw.password !== '' && sshRaw.password !== prevSsh.password) {
            password = await this.crypto.encrypt(sshRaw.password)
          }
          let passphrase = prevSsh.passphrase || ''
          if (typeof sshRaw.passphrase === 'string' && sshRaw.passphrase !== '' && sshRaw.passphrase !== prevSsh.passphrase) {
            passphrase = await this.crypto.encrypt(sshRaw.passphrase)
          }
          let keyPath = prevSsh.keyPath || ''
          if (typeof sshRaw.keyPath === 'string' && sshRaw.keyPath.trim() !== '' && sshRaw.keyPath.trim() !== prevSsh.keyPath) {
            keyPath = sshRaw.keyPath.trim()
          } else if (sshRaw.keyPath === '' && prevSsh.keyPath && (sshRaw.host !== undefined || sshRaw.user !== undefined)) {
            // 前端编辑时 keyPath 留空 = 不变；仅当显式传空字符串且带了其它 SSH 字段才算「清除」
            // 这里按「留空不变」处理（与密码一致），真正清除请在其它字段也变化时再删。
          }
          item.ssh = {
            host: String(sshRaw.host || prevSsh.host || '').trim(),
            port: Number(sshRaw.port) || Number(prevSsh.port) || 22,
            user: String(sshRaw.user || prevSsh.user || '').trim(),
            auth: sshRaw.auth || prevSsh.auth || 'password',
            keyPath,
            password,
            passphrase,
          }
          if (item.ssh.keyPath === '') delete item.ssh.keyPath
          if (item.ssh.password === '') delete item.ssh.password
          if (item.ssh.passphrase === '') delete item.ssh.passphrase
        }
        cleaned.push(item)
      }
      if (cleaned.length > 0) {
        patch.targets = cleaned
        if (action.activeTargetId && cleaned.some((t) => t.id === action.activeTargetId)) {
          patch.activeTargetId = action.activeTargetId
        } else if (this.activeTargetId && !cleaned.some((t) => t.id === this.activeTargetId)) {
          patch.activeTargetId = cleaned[0].id
        }
      }
    }
    if (action.activeTargetId && !Array.isArray(action.targets)) {
      const exists = Array.isArray(this.config.targets)
        ? this.config.targets.some((t) => t.id === action.activeTargetId)
        : false
      if (exists) patch.activeTargetId = action.activeTargetId
    }
    Object.assign(this.config, patch)
    this._persistConfig()
    await this._prepareCreds()
    // 配置变化：强制重建所有目标执行器（新凭据 / dockerPath 立即生效）
    for (const [, entry] of this.targets) {
      try {
        entry.exec.dispose()
      } catch {
        /* ignore */
      }
    }
    this.targets.clear()
    this._buildTargets()
    // 若配置里切换了 activeTargetId，同步到运行时
    if (this.config.activeTargetId && this.targets.has(this.config.activeTargetId)) {
      this.activeTargetId = this.config.activeTargetId
    }
    // 关闭交互终端（目标可能变化）
    for (const session of [...this.shellSessions.keys()]) {
      try {
        await this.closeShell(session)
      } catch {
        /* ignore */
      }
    }
    // 重启轮询
    if (this.timer) clearInterval(this.timer)
    const interval = Number(this.config.pollIntervalMs) || DEFAULT_POLL_MS
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {})
    }, Math.max(3000, interval))
    this.timer.unref?.()
    await this.refresh()
    this._scheduleCatalogRefresh(true)
    this.snapshot.config = this._publicConfig()
    return { ok: true, snapshot: this.snapshot }
  }

  _findTargetConfig(id) {
    const targets = Array.isArray(this.config.targets) ? this.config.targets : []
    return targets.find((t) => t.id === id) || null
  }

  _q(v) {
    // 简单 shell 引号包裹（server/profile 名通常是 [a-z0-9-_]）
    return `'${String(v).replace(/'/g, "'\\''")}'`
  }

  _publicConfig() {
    const targets = Array.isArray(this.config.targets) ? this.config.targets : []
    const list = targets.map((t) => {
      const base = { id: t.id, name: t.name || t.id, type: t.type }
      if (t.type === 'local') {
        base.dockerPath = t.dockerPath || ''
        return base
      }
      const ssh = t.ssh || {}
      base.ssh = {
        host: ssh.host || '',
        port: ssh.port || 22,
        user: ssh.user || '',
        auth: ssh.auth || 'password',
        keyPath: ssh.keyPath || '',
        passwordSet: Boolean(ssh.password),
        passphraseSet: Boolean(ssh.passphrase),
      }
      return base
    })
    return {
      pollIntervalMs: Number(this.config.pollIntervalMs) || DEFAULT_POLL_MS,
      targets: list,
      activeTargetId: this.activeTargetId || this.config.activeTargetId || (list[0] ? list[0].id : ''),
      catalogRef: CATALOG_REF,
    }
  }

  _persistConfig() {
    try {
      if (!this.configPath) return
      mkdirSync(dirname(this.configPath), { recursive: true })
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  getSnapshot() {
    return this.snapshot
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const [, entry] of this.targets) {
      try {
        entry.exec.dispose()
      } catch {
        /* ignore */
      }
    }
    this.targets.clear()
  }
}
