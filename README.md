# dsh-mcp-gateway-board

DeepSeek Harness Web 插件：侧边栏「Docker MCP」管理面板。经 SSH 在远端服务器执行 `docker mcp` CLI，管理 Docker MCP Catalog 中的 MCP（profile 部署/移除、catalog 搜索、gateway 启停）。

**免构建（build-free）**：Host 半区（`lib/index.js`）与 Client 半区（`lib/client.js`）均为纯 ESM JavaScript；Host 端 spawn Python `ssh-exec.py`（paramiko）；Client 端零依赖纯 DOM。

## 架构

```
┌──────────────────── DSH Web GUI（浏览器） ────────────────────┐
│ lib/client.js（纯 DOM）                                          │
│   侧边栏「Docker MCP」⇄ 已部署/仓库双 tab + 搜索 + profile 管理    │
└──────────────────────────┬────────────────────────────────────┘
                           │ 同源 HTTP（loopback-only）
┌──────────────────────────▼────────────────────────────────────┐
│ DSH Host · lib/index.js                                          │
│   McpGatewayBoardService：SSH + docker mcp 命令 + 快照缓存        │
│   GET /api/mcp-gateway-board/{state,catalog} · POST /action      │
│   配置 ~/.dsh/mcp-gateway-board/config.json                      │
└──────────────────────────┬────────────────────────────────────┘
                           │ SSH（paramiko 常驻连接）
                    ┌──────▼──────┐
                    │ 远端服务器   │  docker mcp profile/catalog/gateway
                    │ Docker Engine│  MCP servers in containers
                    └─────────────┘
```

## 安装

```bash
# <repo-path> 为克隆/解压后的插件目录
dsh plugin --profile web add link:<repo-path>
dsh web
```

等价手工方式（离线 / 无 registry）：

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 增加：
   `"dsh-mcp-gateway-board": "file:<repo-path>"`
2. 在 `dsh.profile.bundles` 数组追加 `dsh-mcp-gateway-board`
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 保留：
   ```yaml
   - insert:
       - id: mcp-gateway-board
         name: 'dsh-mcp-gateway-board'
   ```
4. 在 profile 目录执行 `npm install`，重启 `dsh web`

## 配置

优先级：环境变量 > `~/.dsh/mcp-gateway-board/config.json` > cordis 行内 config

| 环境变量 | 说明 |
|----------|------|
| `MCPGW_SSH_HOST` | SSH 主机 |
| `MCPGW_SSH_PORT` | SSH 端口（默认 22） |
| `MCPGW_SSH_USER` | SSH 用户 |
| `MCPGW_SSH_PWD` | SSH 密码（建议用 env，不写进 config.json） |

运行时配置示例（`~/.dsh/mcp-gateway-board/config.json`，**位于用户主目录、勿提交 git**）：

```json
{
  "pollIntervalMs": 8000,
  "ssh": {
    "host": "203.0.113.10",
    "port": 22,
    "user": "root",
    "password": "<从环境变量读取更佳>"
  }
}
```

> ⚠️ **隐私说明**：本项目代码不包含任何服务器地址、账号或密码。SSH 主机/端口/用户名/密码等连接信息**由每个用户在自己的机器上配置**，仅存于本机（密码经 Windows DPAPI 加密，仅当前用户可解密），不会进入代码仓库。推荐通过环境变量 `MCPGW_SSH_*` 注入，或直接在插件「连接设置」弹窗中填写。详见 [SECURITY.md](SECURITY.md)。

## 远端前置条件

- Docker Engine + `docker-mcp` CLI 插件（`~/.docker/cli-plugins/docker-mcp`）
- `export DOCKER_MCP_IN_CONTAINER=1`（无 Docker Desktop 时）
- `docker mcp feature enable profiles`
- `docker mcp catalog pull mcp/docker-mcp-catalog`
- 本机 Python 3 + `paramiko`（供 `ssh-exec.py`）

## 与 dsh-taskagent-board 的关系

并列的两个自有看板插件：`taskagent-board` 连 taskagent MCP（9300）；本插件经 SSH 管理远端 `docker mcp`。面板互斥仅在这两个插件之间处理，不修改 `@linxin666/*` 第三方插件。

## 安全

SSH 主机、端口、用户名、密码等连接信息由每个用户在自己的机器上配置，仅存于本机（密码经 Windows DPAPI 加密），不进入代码仓库。详见 [SECURITY.md](SECURITY.md)。
