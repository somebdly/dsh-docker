// Host 端 SSH 命令执行服务：spawn 一个常驻的 python ssh-exec.py 进程，
// 通过 stdin/stdout「一行一个 JSON」协议复用单个 paramiko SSH 连接执行
// 远端命令（默认 docker mcp ...）。凭据经环境变量注入，不落命令行。

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, 'ssh-exec.py')

export class SshService {
  constructor({ ssh, python = null, onEvent = null }) {
    this.ssh = ssh || {}
    this.python = python
    this.onEvent = onEvent || null
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.stdoutBuf = ''
    this.connected = false
    this.lastError = ''
    this.disposed = false
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

  start() {
    if (this.proc) return
    const env = {
      ...process.env,
      MCPGW_SSH_HOST: String(this.ssh.host || ''),
      MCPGW_SSH_PORT: String(this.ssh.port || 22),
      MCPGW_SSH_USER: String(this.ssh.user || ''),
      MCPGW_SSH_PWD: String(this.ssh.password || ''),
      MCPGW_SSH_AUTH: String(this.ssh.auth || 'password'),
      MCPGW_SSH_KEY: String(this.ssh.keyPath || ''),
      MCPGW_SSH_PASSPHRASE: String(this.ssh.passphrase || ''),
      PYTHONIOENCODING: 'utf-8',
    }
    const python = this.python || process.env.PYTHON || 'python'
    this.proc = spawn(python, [SCRIPT_PATH], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc.unref()

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk))
    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk)
      if (process.env.DSH_DEBUG) console.error('[dsh-docker ssh-exec]', text.trim())
    })
    this.proc.on('error', (error) => {
      this.lastError = `ssh-exec 进程错误: ${error.message}`
      this.connected = false
      this._emit({ type: 'proc-error', error: this.lastError })
    })
    this.proc.on('exit', (code, signal) => {
      this.connected = false
      const reason = signal ? `signal ${signal}` : `code ${code}`
      this._failAll(new Error(`ssh-exec 进程退出 (${reason})`))
      this.proc = null
      if (!this.disposed) {
        this._emit({ type: 'proc-exit', code, signal })
      }
    })
  }

  _onStdout(chunk) {
    this.stdoutBuf += String(chunk)
    let idx
    while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim()
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      if (line === '') continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        this.lastError = `ssh-exec 返回非 JSON: ${line.slice(0, 200)}`
        continue
      }
      this._onMessage(msg)
    }
  }

  _onMessage(msg) {
    // 异步事件（PTY 输出/退出、进程事件）：id=0 且无 pending，转发给上层
    if (msg && msg.event) {
      this._emit({ ...msg, type: msg.event })
      return
    }
    const id = msg && msg.id
    if (id !== undefined && id !== null && this.pending.has(id)) {
      const { resolve, reject, timer } = this.pending.get(id)
      this.pending.delete(id)
      clearTimeout(timer)
      if (msg.ok) {
        this.connected = true
        resolve({ stdout: msg.stdout || '', stderr: msg.stderr || '', exit: msg.exit ?? 0, session: msg.session || '', data: msg.data || '' })
      } else {
        this.lastError = msg.error || 'ssh-exec 执行失败'
        reject(new Error(this.lastError))
      }
    }
  }

  _failAll(error) {
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
  }

  exec(cmd, timeoutMs = 60_000) {
    if (this.disposed) return Promise.reject(new Error('ssh-service 已关闭'))
    this.start()
    if (!this.proc) return Promise.reject(new Error('ssh-exec 进程未启动'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`SSH 命令超时 (${timeoutMs}ms): ${cmd.slice(0, 80)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this._write({ id, cmd, timeout: Math.max(5, Math.floor(timeoutMs / 1000)) })
    })
  }

  _req(obj, timeoutMs = 30_000) {
    // 通用 JSON 请求（支持 type 字段，如 pty-open/pty-in/...），等待响应
    if (this.disposed) return Promise.reject(new Error('ssh-service 已关闭'))
    this.start()
    if (!this.proc) return Promise.reject(new Error('ssh-exec 进程未启动'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`SSH 请求超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this._write({ id, ...obj, timeout: Math.max(5, Math.floor(timeoutMs / 1000)) })
    })
  }

  openPty(cmd, timeoutMs = 300_000) {
    return this._req({ type: 'pty-open', cmd }, timeoutMs)
  }

  writePty(session, data) {
    return this._req({ type: 'pty-in', session, data }, 15_000)
  }

  resizePty(session, cols, rows) {
    return this._req({ type: 'pty-resize', session, cols, rows }, 15_000)
  }

  closePty(session) {
    return this._req({ type: 'pty-close', session }, 15_000)
  }

  _write(obj) {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) return
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n')
    } catch {
      /* ignore */
    }
  }

  async ping() {
    try {
      await this.exec('ping', 15_000)
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  dispose() {
    this.disposed = true
    this._failAll(new Error('ssh-service 已关闭'))
    if (this.proc) {
      try {
        this._write({ id: 0, cmd: 'quit' })
      } catch {
        /* ignore */
      }
      const proc = this.proc
      this.proc = null
      setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
      }, 1500)
    }
  }
}
