// Host 端「本机目标」执行器：在本机（Windows）直接跑 docker.exe / docker-mcp。
// 与 SshService 保持同一接口（exec / execJson / ping / dispose），使 host-service
// 能以目标为单位统一分发。
//
// 命令以「字符串」传入（与 SSH 路径一致，host-service 现有 `_q()` 生成单引号 token），
// 这里把命令字符串按 shell 风格解析为 argv：支持单引号 'token'（含内部转义 \'）与
// 裸 token；解析结果直接用 execFile 执行，不经过 cmd.exe，杜绝注入。

import { execFile, spawn } from 'node:child_process'

// 把 `docker ... 'token' ...` 拆成 argv 数组。规则：
//  - 单引号片段作为一个 token（内部 '' 视作字面单引号）
//  - 无引号 token 按空白切分
//  - 双引号不支持（现有代码只产单引号）；遇到裸双引号按普通字符并入 token
export function parseCommandArgs(cmd) {
  const tokens = []
  let i = 0
  const n = cmd.length
  let cur = ''
  let inTok = false
  let inSingle = false
  while (i < n) {
    const c = cmd[i]
    if (inSingle) {
      if (c === "'") {
        // 支持 '' 表示字面单引号
        if (cmd[i + 1] === "'") {
          cur += "'"
          i += 2
          continue
        }
        inSingle = false
        i += 1
        continue
      }
      cur += c
      i += 1
      continue
    }
    if (c === "'") {
      inSingle = true
      inTok = true
      i += 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      if (inTok) {
        tokens.push(cur)
        cur = ''
        inTok = false
      }
      i += 1
      continue
    }
    inTok = true
    cur += c
    i += 1
  }
  if (inSingle) {
    // 未闭合单引号：整体作为单个 token（宽松处理）
  }
  if (inTok || cur !== '') tokens.push(cur)
  return tokens
}

export class LocalExecService {
  constructor({ dockerPath = null, onEvent = null } = {}) {
    this.dockerPath = dockerPath || process.env.DOCKER_CLI_PATH || ''
    this.onEvent = onEvent || null
    this.disposed = false
    this.connected = false
    this.lastError = ''
    this.nextId = 1
    this.pending = new Map()
    // gateway 子进程句柄（本机跑 docker mcp gateway 用）
    this.gatewayProc = null
  }

  _emit(event) {
    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent(event)
      } catch {
        /* ignore */
      }
    }
  }

  // 解析命令首 token，返回 { exe, args, fullArgs }
  _resolve(cmd) {
    const tokens = parseCommandArgs(cmd)
    if (tokens.length === 0) throw new Error('空命令')
    const head = tokens[0]
    let exe = ''
    let args = tokens
    if (head === 'docker' || head === 'docker.exe') {
      exe = this.dockerPath || 'docker'
      args = tokens.slice(1)
    } else if (head === 'docker-mcp' || head === 'docker-mcp.exe') {
      exe = this.dockerPath.replace(/docker\.exe$/i, 'docker-mcp.exe') || 'docker-mcp'
      args = tokens.slice(1)
    } else {
      // 非 docker 命令（如 ps/ss/netstat 等平台探测命令），本机不支持直接 execFile 的复杂管道
      // 由调用方负责分支；这里抛出明确错误。
      throw new Error(`本机目标不支持命令: ${head}（请使用 SSH 目标）`)
    }
    return { exe, args }
  }

  start() {
    // 本机执行无常驻进程，无需 start
    this.connected = true
  }

  exec(cmd, timeoutMs = 60_000) {
    if (this.disposed) return Promise.reject(new Error('local-exec 已关闭'))
    let resolved
    try {
      resolved = this._resolve(cmd)
    } catch (error) {
      return Promise.reject(error)
    }
    const { exe, args } = resolved
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // docker mcp 需要 DOCKER_MCP_IN_CONTAINER=1 绕过 Docker Desktop 特征检查
      // （docker mcp 是 docker CLI 的 cli-plugin，命令形态为 `docker mcp ...`；
      //   也可能直接是 docker-mcp.exe 二进制，如 gateway run）
      const env = { ...process.env }
      const isMcp = exe.toLowerCase().includes('docker-mcp') || (args[0] || '').toLowerCase() === 'mcp'
      if (isMcp) env.DOCKER_MCP_IN_CONTAINER = '1'
      const child = execFile(
        exe,
        args,
        { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env },
        (error, stdout, stderr) => {
          this.pending.delete(id)
          const exit = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
          if (error && error.killed) {
            reject(new Error(`本机命令超时 (${timeoutMs}ms): ${exe} ${args.join(' ').slice(0, 80)}`))
            return
          }
          this.connected = true
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), exit, session: '', data: '' })
        },
      )
      const timer = setTimeout(() => {
        this.pending.delete(id)
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        reject(new Error(`本机命令超时 (${timeoutMs}ms): ${exe} ${args.join(' ').slice(0, 80)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.once('exit', () => clearTimeout(timer))
    })
  }

  // 通用 JSON 请求（与 SshService._req 对应）。本机无 PTY，仅支持简单指令。
  _req(obj, timeoutMs = 30_000) {
    const type = obj.type || ''
    if (type === 'pty-open' || type === 'pty-in' || type === 'pty-resize' || type === 'pty-close') {
      return Promise.reject(new Error('本机目标暂不支持交互终端（请使用 SSH 目标）'))
    }
    return Promise.reject(new Error(`本机目标不支持请求类型: ${type}`))
  }

  openPty() {
    return this._req({ type: 'pty-open' })
  }

  writePty() {
    return this._req({ type: 'pty-in' })
  }

  resizePty() {
    return this._req({ type: 'pty-resize' })
  }

  closePty() {
    return this._req({ type: 'pty-close' })
  }

  async ping() {
    try {
      await this.exec('docker version --format {{.Server.Version}}', 15_000)
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  dispose() {
    this.disposed = true
    for (const [, { reject }] of this.pending) {
      try {
        reject(new Error('local-exec 已关闭'))
      } catch {
        /* ignore */
      }
    }
    this.pending.clear()
    this._stopGatewayProcess()
  }

  // ---- 本机 gateway 进程管理（Windows）----
  // 本机跑 docker mcp gateway：spawn docker-mcp.exe gateway run ...
  // 通过 execFile 方式无法保留后台进程，故用 spawn detached。
  _gatewayExe() {
    const base = this.dockerPath.replace(/docker\.exe$/i, '') || ''
    return base ? `${base}docker-mcp.exe` : 'docker-mcp'
  }

  _stopGatewayProcess() {
    if (this.gatewayProc) {
      try {
        this.gatewayProc.kill()
      } catch {
        /* ignore */
      }
      this.gatewayProc = null
    }
  }
}

export default LocalExecService
