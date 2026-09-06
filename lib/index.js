// Host 入口：挂载 Docker MCP Gateway 看板服务、HTTP 路由、以及面向模型的公告 section。
// 配置来源优先级：环境变量 > 运行时 JSON 文件 > cordis 行内 config > 默认值。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { McpGatewayBoardService } from './host-service.js'
import { makeRoutes } from './host-routes.js'

export const inject = ['webServer', 'systemPrompt']

const SECTION_ORDER = 221
export const CONFIG_PATH = join(homedir(), '.dsh', 'mcp-gateway-board', 'config.json')

const GUIDANCE =
  '本机已安装 dsh-docker-board 插件（Docker 管理面板，原 Docker MCP Gateway 面板）：侧边栏「Docker」入口；' +
  '经 SSH 在远端服务器（地址在插件「连接设置」中配置）管理 Docker 与 Docker MCP（docker/mcp-gateway）。' +
  'MCP 能力：查看已部署的 MCP（profile 中的 servers）、部署/移除 MCP、搜索/拉取 Docker MCP Catalog（官方仓库 314 个 MCP）、' +
  '启停/重启 MCP Gateway、自定义部署（远端 https MCP 地址，或镜像地址——非自描述镜像如 mcp/sqlite 需先本地 docker pull 成功、gateway 以 --pull never 加载本地镜像）。' +
  '自定义部署直接写远端 profile 数据库（working_set），写入后需重启 gateway 生效（面板一键重启，自动带 --verify-signatures=false 解决镜像签名校验访问 Docker Hub CDN 被墙的问题）；' +
  'Docker 容器能力：「容器」tab 管理远端容器与镜像——列表/启停/重启/删除/日志/详情/进入容器终端(docker exec -it 交互式 shell)/清理停止容器/新建容器(docker run，支持端口/环境变量/卷/命令)/拉取镜像/构建镜像(docker build)/导入镜像(docker load)，高危操作（停止/重启/删除/清理）带二次确认；' +
  '安全：SSH 认证支持密码或密钥二选一，凭据以 Windows DPAPI 加密存储在本机（仅当前用户可解密，不明文落盘）；' +
  'gateway 是常驻进程按需拉起 server 容器。' +
  '用户提到「docker mcp / docker 管理 / 容器管理 / docker 容器 / 镜像 / 自定义部署 / 重启 gateway」时即指本插件，请据此协作。'

function loadConfigFile() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function resolveConfig(cordisConfig) {
  const defaults = {
    announceToAgent: true,
    pollIntervalMs: 8_000,
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
  if (process.env.MCPGW_SSH_HOST) merged.ssh.host = process.env.MCPGW_SSH_HOST
  if (process.env.MCPGW_SSH_PORT) merged.ssh.port = Number(process.env.MCPGW_SSH_PORT) || 22
  if (process.env.MCPGW_SSH_USER) merged.ssh.user = process.env.MCPGW_SSH_USER
  if (process.env.MCPGW_SSH_PWD) merged.ssh.password = process.env.MCPGW_SSH_PWD
  if (process.env.MCPGW_SSH_AUTH) merged.ssh.auth = process.env.MCPGW_SSH_AUTH
  if (process.env.MCPGW_SSH_KEY) merged.ssh.keyPath = process.env.MCPGW_SSH_KEY
  if (process.env.MCPGW_SSH_PASSPHRASE) merged.ssh.passphrase = process.env.MCPGW_SSH_PASSPHRASE
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
  }, 'mcp-gateway-board: routes')

  if (cfg.announceToAgent !== false) {
    ctx.effect(
      () => ctx.systemPrompt.section({ name: 'plugin:mcp-gateway-board', order: SECTION_ORDER, text: GUIDANCE }),
      'mcp-gateway-board: prompt',
    )
  }
}
