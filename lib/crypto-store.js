// 本地凭据加密存储：Windows DPAPI（ProtectedData, CurrentUser scope）。
// 密文只能被当前 Windows 用户解密——满足「本地加密存储」要求，明文不落盘。
// 通过 PowerShell 调 .NET（node 无原生 DPAPI 绑定），结果进程内缓存。
//
// 用法：
//   const store = new CryptoStore()
//   const enc = await store.encrypt('my-secret')          // -> base64(DPAPI)
//   const plain = await store.decrypt(enc)                // -> 'my-secret'（失败返回 null）
//
// 迁移：旧的明文 password 首次 decrypt 返回 null（不是合法密文），
// 调用方识别后自动用 encrypt() 重写为密文。

import { spawn } from 'node:child_process'

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {}
$mode = $env:CRYPTO_MODE
$b64 = $env:CRYPTO_DATA
$bytes = [Convert]::FromBase64String($b64)
if ($mode -eq 'encrypt') {
  $prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  [Convert]::ToBase64String($prot)
} else {
  $unprot = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
  [Convert]::ToBase64String($unprot)
}
`

function runPowershell(script, env) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }))
    child.on('close', (code) => {
      if (code === 0 && out.trim() !== '') resolve({ ok: true, value: out.trim() })
      else resolve({ ok: false, error: (err || out).trim().slice(0, 300) || `exit=${code}` })
    })
  })
}

export class CryptoStore {
  constructor() {
    this.cache = new Map() // b64密文 -> 明文
  }

  async encrypt(plain) {
    if (typeof plain !== 'string' || plain === '') return ''
    const b64 = Buffer.from(plain, 'utf8').toString('base64')
    const res = await runPowershell(PS_SCRIPT, { CRYPTO_MODE: 'encrypt', CRYPTO_DATA: b64 })
    if (!res.ok) throw new Error(`DPAPI 加密失败: ${res.error}`)
    this.cache.set(res.value, plain)
    return res.value
  }

  async decrypt(enc) {
    if (typeof enc !== 'string' || enc === '') return ''
    if (this.cache.has(enc)) return this.cache.get(enc)
    const res = await runPowershell(PS_SCRIPT, { CRYPTO_MODE: 'decrypt', CRYPTO_DATA: enc })
    if (!res.ok) return null // 不是合法 DPAPI 密文（可能是旧明文配置）或解密失败
    const plain = Buffer.from(res.value, 'base64').toString('utf8')
    this.cache.set(enc, plain)
    return plain
  }
}
