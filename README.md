# dsh-docker

> DeepSeek Harness (DSH) Web 插件 · Docker 管理面板（Docker MCP Gateway 管理 + 容器/镜像管理）

`dsh-docker`（插件 id：`dsh-docker`）是 DeepSeek Harness Web GUI 的侧边栏「Docker」面板插件。它把 Docker 生态的两大类操作统一放进一个免构建的 Web 面板：

- **Docker MCP 管理**：查看/部署/移除 profile 中的 MCP server、搜索/拉取官方 Docker MCP Catalog、启停/重启 MCP Gateway、自定义部署（远端 https 或本地镜像）
- **容器与镜像管理**：容器列表/启停/重启/删除/日志/详情/交互式终端、清理停止容器、新建容器、拉取/构建/导入/运行镜像、**批量勾选删除镜像**

支持**多管理目标**：可在「本机 CLI」与「SSH 远端服务器」之间切换，切换后所有 tab（MCP / 容器 / 镜像）都针对当前目标。

---

## ✨ 功能特性

### 多目标管理
- 面板顶部目标选择器，一键切换管理目标
- **本机目标（local）**：在本机直接执行 `docker` / `docker mcp` 命令，容器操作经当前 docker context 连接 daemon
- **SSH 目标（remote）**：经 paramiko 常驻 SSH 连接在远端执行 `docker mcp` CLI，管理远端的 Docker Engine 与 MCP

### Docker MCP 管理（MCP tab）
- 查看已部署的 MCP（profile 中的 servers）
- 部署 / 移除 MCP server（`docker mcp`）
- 搜索 / 拉取官方 **Docker MCP Catalog**（仓库 300+ 个 MCP）
- 启停 / 重启 **MCP Gateway**（常驻进程，按需拉起 server 容器）
- **自定义部署**：远端 https MCP 地址，或本地镜像地址（非自描述镜像如 `mcp/sqlite` 需先本地 `docker pull` 成功，gateway 以 `--pull never` 加载本地镜像）
- profile 管理：新建 / 删除 profile

### 容器与镜像管理（容器 tab）
- 容器：列表 / 启动 / 停止 / 重启 / 删除 / 日志 / 详情 / 交互式终端（`docker exec -it`，SSH 目标支持）/ 清理停止容器
- 新建容器：`docker run`，支持端口、环境变量、卷、命令参数；默认开启「保持运行」（未填命令时自动追加 `tail -f /dev/null` 保活，防止容器启动后退出）
- 镜像：拉取 / 构建（`docker build`）/ 导入（`docker load`）/ 运行 / 单个删除 / **批量勾选删除**（表格行勾选或全选，一键 `docker rmi` 多个镜像；悬空 `<none>` 镜像自动按 ID 删除）
- 高危操作（停止 / 重启 / 删除 / 清理）带二次确认

### 安全设计
- SSH 认证支持**密码或密钥**二选一，凭据以 **Windows DPAPI** 加密存储在本机（仅当前用户可解密，不明文落盘）
- 面板 HTTP 仅允许 **loopback**（127.0.0.1 / ::1）访问
- 命令注入防护：容器 ID、镜像名、端口、路径等经白名单正则校验后才拼进命令
- 凭据不落命令行：SSH 连接经 Python 子进程从环境变量读取凭据

### 工程特性
- **免构建（build-free）**：Host 端与 Client 端均为纯 ESM JavaScript，Client 端零依赖纯 DOM
- 配置优先级：环境变量 > `config.json` > cordis 行内 config
- 代码仓库零凭据：所有连接信息由用户在本机配置，不进入代码仓库

---

## 🏗️ 架构

```
┌──────────────────── DSH Web GUI（浏览器） ────────────────────┐
│ lib/client.js（纯 DOM，零依赖）                                   │
│   侧边栏「Docker」⇄ MCP / 容器 / 镜像 tab + 目标切换 + 终端         │
└──────────────────────────┬────────────────────────────────────┘
                           │ 同源 HTTP（loopback-only）
┌──────────────────────────▼────────────────────────────────────┐
│ DSH Host · lib/index.js                                          │
│   McpGatewayBoardService：多目标分发 + MCP/Gateway + Docker 操作   │
│   GET /api/dsh-docker/{state,catalog}                     │
│   POST /api/dsh-docker/{action,shell/*}                   │
│   配置 ~/.dsh/dsh-docker/config.json                       │
└──────────┬──────────────────────────────┬──────────────────────┘
           │ local                        │ ssh（paramiko 常驻连接）
    ┌──────▼──────┐                ┌──────▼──────┐
    │ 本机 docker │                │ 远端 Docker │  docker mcp profile/catalog/gateway
    │ context     │                │ Engine      │  MCP servers in containers
    └─────────────┘                └─────────────┘
```

### 模块职责

| 模块 | 职责 |
|---|---|
| `lib/index.js` | Host 入口：配置解析、服务挂载、系统提示注入 |
| `lib/host-service.js` | 核心服务：多目标管理、MCP/Gateway 操作、Docker 容器/镜像操作、快照轮询 |
| `lib/host-routes.js` | HTTP 路由（loopback-only）：state / catalog / action / shell 系列端点 |
| `lib/client.js` | 前端 UI：面板、目标切换、MCP/容器/镜像 tab、交互终端 |
| `lib/ssh-service.js` | SSH 执行服务：spawn 常驻 `ssh-exec.py`，一行一 JSON 协议 |
| `lib/ssh-exec.py` | paramiko 常驻 SSH 进程：命令执行 + PTY 交互终端 |
| `lib/local-exec.js` | 本机 docker 执行：`execFile` + shell 风格命令解析（防注入） |
| `lib/local-db.js` | 本机 `~/.docker/mcp/mcp-toolkit.db` 的 working_set 读写（node:sqlite） |
| `lib/crypto-store.js` | Windows DPAPI 凭据加密存储（ProtectedData·CurrentUser） |
| `scripts/wsl-docker-setup.sh` | WSL2 Ubuntu 一键安装 Docker Engine + docker mcp（含清华镜像 fallback） |

---

## 📦 安装

### 方式一：dsh CLI（推荐）

```bash
# <repo-path> 为克隆/解压后的插件目录
dsh plugin --profile web add link:<repo-path>
dsh web
```

### 方式二：手工配置

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 增加：

   ```json
   "dsh-docker": "file:<repo-path>"
   ```

2. 在 `dsh.profile.bundles` 数组追加 `dsh-docker`
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 保留：

   ```yaml
   - insert:
       - id: dsh-docker
         name: 'dsh-docker'
   ```

4. 在 profile 目录执行 `npm install`，重启 `dsh web`

安装后侧边栏出现「Docker」入口，点击打开管理面板。

---

## ⚙️ 配置

配置来源优先级：**环境变量 > `~/.dsh/dsh-docker/config.json` > cordis 行内 config**

### 环境变量

| 环境变量 | 说明 |
|---|---|
| `MCPGW_SSH_HOST` | SSH 主机 |
| `MCPGW_SSH_PORT` | SSH 端口（默认 22） |
| `MCPGW_SSH_USER` | SSH 用户 |
| `MCPGW_SSH_PWD` | SSH 密码（建议用 env，不写进 config.json） |
| `MCPGW_SSH_AUTH` | 认证方式：`password`（默认）或 `key` |
| `MCPGW_SSH_KEY` | 私钥路径（auth=key 时使用） |
| `MCPGW_SSH_PASSPHRASE` | 私钥口令（可选） |

### 运行时配置（`~/.dsh/dsh-docker/config.json`，位于用户主目录、勿提交 git）

```json
{
  "pollIntervalMs": 8000,
  "activeTargetId": "remote",
  "targets": [
    {
      "id": "local",
      "name": "本机 Docker",
      "type": "local",
      "dockerPath": ""
    },
    {
      "id": "remote",
      "name": "远端服务器",
      "type": "ssh",
      "ssh": {
        "host": "203.0.113.10",
        "port": 22,
        "user": "root",
        "auth": "password",
        "password": "<DPAPI 密文，或留空用环境变量>"
      }
    }
  ]
}
```

> 旧版单 `ssh` 配置会自动迁移为 `targets` 数组中的 SSH 目标。

### 推荐配置方式

1. **插件「连接设置」弹窗**（推荐）：侧边栏「Docker」→ 右上「设置」→ 填写 SSH host / port / user，选择认证方式（密码或密钥），保存。密码经 DPAPI 加密落盘，界面不回显。
2. **环境变量**：适合脚本/CI，不落盘。
3. **手工写 config.json**：如上示例。

---

## 🖥️ 使用

### 面板布局

- **顶部**：管理目标选择器（本机 / SSH 远端）+ 连接状态指示 + 设置按钮
- **MCP tab**：已部署（deployed）/ 仓库（catalog）两个子页
  - 已部署：查看 profile 中的 MCP servers，部署/移除
  - 仓库：搜索官方 Docker MCP Catalog，一键部署
- **容器 tab**：容器（ps）/ 镜像（images）两个子页
  - 容器：列表、启停/重启/删除、日志、详情、进入终端、清理停止容器、新建容器
  - 镜像：拉取、构建、导入、运行、单个删除、批量勾选删除

### 交互式容器终端（仅 SSH 目标）

1. 在容器列表点击「终端」
2. 面板内打开 `docker exec -it <container> sh` 交互式 shell（PTY）
3. 支持实时输入输出、窗口尺寸调整、关闭会话

### 自定义部署 MCP

- **远端 https 地址**：直接填 MCP server URL
- **本地镜像**：先在本机 `docker pull <image>` 成功，再填镜像地址；gateway 以 `--pull never` 加载本地镜像
- 写入目标 profile 的 working_set 后需**重启 gateway 生效**（面板一键重启，自动带 `--verify-signatures=false` 解决镜像签名校验访问 Docker Hub CDN 被墙的问题）

---

## 🔒 安全

| 信息 | 存放位置 | 是否进入仓库 |
|---|---|---|
| SSH 主机/端口/用户名 | `config.json`（用户主目录）或环境变量 | ❌ |
| SSH 密码 | DPAPI 密文（仅当前用户可解密） | ❌ |
| 私钥路径/口令 | `config.json` | ❌ |
| 轮询间隔等非敏感配置 | `config.json` | ❌ |

- `config.json` 已被 `.gitignore` 与 `.npmignore` 双重排除，从未也不会进入版本库
- 代码中的示例均为通用占位（`203.0.113.10`、`root` 等），不代表任何真实环境
- 面板 HTTP 仅 loopback；高危操作二次确认；命令注入白名单校验

详见 [SECURITY.md](SECURITY.md)。

---

## 🗂️ 项目结构

```
dsh-docker/
├── lib/
│   ├── index.js            # Host 入口（配置解析、服务挂载）
│   ├── host-service.js     # 核心服务（多目标、MCP、Gateway、Docker 操作）
│   ├── host-routes.js      # HTTP 路由（loopback-only）
│   ├── client.js           # 前端 UI（纯 DOM、免构建）
│   ├── ssh-service.js      # SSH 执行服务（spawn python）
│   ├── ssh-exec.py         # paramiko 常驻 SSH 进程（命令 + PTY）
│   ├── local-exec.js       # 本机 docker 执行
│   ├── local-db.js         # 本机 sqlite working_set 操作
│   └── crypto-store.js     # DPAPI 凭据加密
├── scripts/
│   └── wsl-docker-setup.sh # WSL2 Docker 一键安装脚本
├── cordis.patch.yml        # 插件注册 patch
├── package.json
├── README.md               # 本文档（中文）
└── README.en.md            # English documentation
```

---

## 🛠️ 开发

- **免构建**：直接改 `lib/*.js`，Host 侧改完重启 `dsh web`，Client 侧改完浏览器刷新（Ctrl+F5）
- Host 代码检查：`node --check lib/*.js`
- 远端前置条件：
  - Docker Engine + `docker-mcp` CLI 插件（`~/.docker/cli-plugins/docker-mcp`）
  - `export DOCKER_MCP_IN_CONTAINER=1`（无 Docker Desktop 时）
  - `docker mcp feature enable profiles`
  - `docker mcp catalog pull mcp/docker-mcp-catalog`
  - 本机 Python 3 + `paramiko`（供 `ssh-exec.py`）

---

## 📄 License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
