// Host 入口：挂载 Docker MCP Gateway 看板服务、HTTP 路由、以及面向模型的公告 section。
// 配置来源优先级：环境变量 > 运行时 JSON 文件 > cordis 行内 config > 默认值。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { McpGatewayBoardService } from './host-service.js'
import { makeRoutes } from './host-routes.js'

export const inject = ['webServer', 'systemPrompt']

const SECTION_ORDER = 221
export const CONFIG_PATH = join(homedir(), '.dsh', 'dsh-docker', 'config.json')
// 旧版插件配置路径（dsh-mcp-gateway-board → dsh-docker 改名后）
const LEGACY_CONFIG_PATH = join(homedir(), '.dsh', 'mcp-gateway-board', 'config.json')

const GUIDANCE =
  '本机已安装 dsh-docker-board 插件（Docker 管理面板，原 Docker MCP Gateway 面板）：侧边栏「Docker」入口；' +
  '面板顶部可选择管理目标（本机 CLI / SSH 远端服务器，在「连接设置」中配置），切换后所有 tab（MCP/容器/镜像）即针对该目标。' +
  'MCP 能力：查看已部署的 MCP（profile 中的 servers）、部署/移除 MCP、搜索/拉取 Docker MCP Catalog（官方仓库 314 个 MCP）、' +
  '启停/重启 MCP Gateway、自定义部署（远端 https MCP 地址，或镜像地址——非自描述镜像如 mcp/sqlite 需先本地 docker pull 成功、gateway 以 --pull never 加载本地镜像）。' +
  '自定义部署直接写目标 profile 数据库（working_set，本机目标写本机 ~/.docker/mcp/，SSH 目标写远端），写入后需重启 gateway 生效（面板一键重启，自动带 --verify-signatures=false 解决镜像签名校验访问 Docker Hub CDN 被墙的问题）；' +
  'Docker 容器能力：「容器」tab 管理目标 docker 的容器与镜像——列表/启停/重启/删除/日志/详情/进入容器终端(docker exec -it 交互式 shell，仅 SSH 目标支持)/清理停止容器/新建容器(docker run，支持端口/环境变量/卷/命令)/拉取镜像/构建镜像(docker build)/导入镜像(docker load)，高危操作（停止/重启/删除/清理）带二次确认；' +
  '本机目标（local）直接在本机执行 docker/docker mcp 命令（docker mcp 经 DOCKER_MCP_IN_CONTAINER=1 绕过 Desktop 检查，容器操作经当前 docker context 连 daemon，profile 数据在本机 ~/.docker/mcp/）；' +
  '安全：SSH 认证支持密码或密钥二选一，凭据以 Windows DPAPI 加密存储在本机（仅当前用户可解密，不明文落盘）；' +
  'gateway 是常驻进程按需拉起 server 容器。' +
  '用户提到「docker mcp / docker 管理 / 容器管理 / docker 容器 / 镜像 / 自定义部署 / 重启 gateway」时即指本插件，请据此协作。'

function loadConfigFile() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    // 新路径无配置时，从旧 mcp-gateway-board 配置迁移一次，避免远端目标丢失
    try {
      if (existsSync(LEGACY_CONFIG_PATH)) {
        mkdirSync(join(homedir(), '.dsh', 'dsh-docker'), { recursive: true })
        copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH)
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      }
    } catch {
      /* ignore migrate failure */
    }
    return {}
  }
}

function resolveConfig(cordisConfig) {
  const defaults = {
    announceToAgent: true,
    pollIntervalMs: 8_000,
    activeTargetId: '',
    targets: [],
    ssh: {
      host: '',
      port: 22,
      user: '',
      password: '',
      auth: 'password',
      keyPath: '',
      passphrase: '',
    },
  }
  const file = loadConfigFile()
  const merged = { ...defaults, ...(cordisConfig || {}), ...file }
  if (merged.ssh && typeof merged.ssh === 'object') {
    merged.ssh = { ...defaults.ssh, ...merged.ssh }
  }
  // 环境变量 → 覆盖「第一个 SSH 目标」或旧 ssh 配置
  if (process.env.MCPGW_SSH_HOST) merged.ssh.host = process.env.MCPGW_SSH_HOST
  if (process.env.MCPGW_SSH_PORT) merged.ssh.port = Number(process.env.MCPGW_SSH_PORT) || 22
  if (process.env.MCPGW_SSH_USER) merged.ssh.user = process.env.MCPGW_SSH_USER
  if (process.env.MCPGW_SSH_PWD) merged.ssh.password = process.env.MCPGW_SSH_PWD
  if (process.env.MCPGW_SSH_AUTH) merged.ssh.auth = process.env.MCPGW_SSH_AUTH
  if (process.env.MCPGW_SSH_KEY) merged.ssh.keyPath = process.env.MCPGW_SSH_KEY
  if (process.env.MCPGW_SSH_PASSPHRASE) merged.ssh.passphrase = process.env.MCPGW_SSH_PASSPHRASE

  // 迁移旧版单 ssh 配置 → targets 数组（SSH 目标），保留行为
  const targets = Array.isArray(merged.targets) ? merged.targets : []
  if (targets.length === 0) {
    const hasSsh = Boolean(merged.ssh && (merged.ssh.host || merged.ssh.password || merged.ssh.keyPath))
    if (hasSsh) {
      targets.push({
        id: 'remote',
        name: `远端 ${merged.ssh.host || ''}`.trim() || '远端服务器',
        type: 'ssh',
        ssh: { ...merged.ssh },
      })
      merged.activeTargetId = merged.activeTargetId || 'remote'
    } else {
      // 无任何配置：默认建一个本机目标
      targets.push({ id: 'local', name: '本机 Docker', type: 'local', dockerPath: '' })
      merged.activeTargetId = merged.activeTargetId || 'local'
    }
  }
  merged.targets = targets
  if (!merged.activeTargetId && targets.length > 0) {
    merged.activeTargetId = targets[0].id
  }
  // 环境变量若给了 SSH 主机且 targets 已有 SSH 目标，把 env 值并入第一个 SSH 目标
  if (process.env.MCPGW_SSH_HOST) {
    const sshTarget = merged.targets.find((t) => t.type === 'ssh')
    if (sshTarget) {
      if (!sshTarget.ssh) sshTarget.ssh = {}
      if (process.env.MCPGW_SSH_HOST) sshTarget.ssh.host = process.env.MCPGW_SSH_HOST
      if (process.env.MCPGW_SSH_PORT) sshTarget.ssh.port = Number(process.env.MCPGW_SSH_PORT) || 22
      if (process.env.MCPGW_SSH_USER) sshTarget.ssh.user = process.env.MCPGW_SSH_USER
      if (process.env.MCPGW_SSH_PWD) sshTarget.ssh.password = process.env.MCPGW_SSH_PWD
      if (process.env.MCPGW_SSH_AUTH) sshTarget.ssh.auth = process.env.MCPGW_SSH_AUTH
      if (process.env.MCPGW_SSH_KEY) sshTarget.ssh.keyPath = process.env.MCPGW_SSH_KEY
      if (process.env.MCPGW_SSH_PASSPHRASE) sshTarget.ssh.passphrase = process.env.MCPGW_SSH_PASSPHRASE
    }
  }
  return merged
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const service = new McpGatewayBoardService({ config: cfg, configPath: CONFIG_PATH })
  service.start()

  ctx.effect(() => {
    const disposers = []
    for (const route of makeRoutes(service)) disposers.push(ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      service.dispose()
    }
  }, 'dsh-docker: routes')

  if (cfg.announceToAgent !== false) {
    ctx.effect(
      () => ctx.systemPrompt.section({ name: 'plugin:dsh-docker', order: SECTION_ORDER, text: GUIDANCE }),
      'dsh-docker: prompt',
    )
  }
}
