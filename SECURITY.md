# 安全与凭据存储

本插件**代码仓库不包含任何服务器地址、账号、密码或其他个人/内网信息**。所有连接凭据由每个用户在自己机器上配置，仅存于本机。

## 凭据持久化方案（零仓库泄露）

```
┌─ 用户本机（Windows）───────────────────────────────────────┐
│ 配置来源（优先级从高到低）                                     │
│  1. 环境变量 MCPGW_SSH_*（最高优先，不落盘）                  │
│  2. ~/.dsh/dsh-docker/config.json（用户主目录）                 │
│  3. dsh profile cordis 行内 config                            │
│                                                             │
│  密码 / 密钥口令 → Windows DPAPI 加密后写入 config.json       │
│  （ProtectedData·CurrentUser：仅当前 Windows 用户可解密）     │
└─────────────────────────────────────────────────────────────┘
```

### 为什么仓库是干净的

| 信息 | 存放位置 | 是否进入仓库 |
|------|----------|:---:|
| SSH 主机/端口/用户名 | `config.json`（用户主目录）或环境变量 | ❌ |
| SSH 密码 | DPAPI 密文（仅当前用户可解密） | ❌ |
| 私钥路径/口令 | `config.json` | ❌ |
| 轮询间隔等非敏感配置 | `config.json` | ❌ |

- `config.json` 已被 `.gitignore` 与 `.npmignore` 双重排除，从未也不会进入版本库。
- 代码中的示例均为通用占位（`203.0.113.10`、`root`、`/home/user/...`），不代表任何真实环境。

### 配置方式（每个用户在自己的机器上执行其一）

**方式 A：插件「连接设置」弹窗（推荐）**

侧边栏「Docker」→ 右上「设置」→ 填写 SSH host / port / user，选择认证方式（密码或密钥），保存。密码经 DPAPI 加密落盘，界面不回显。

**方式 B：环境变量（适合脚本/CI，不落盘）**

```bash
export MCPGW_SSH_HOST=203.0.113.10
export MCPGW_SSH_PORT=22
export MCPGW_SSH_USER=root
export MCPGW_SSH_AUTH=password        # 或 key
export MCPGW_SSH_PWD='...'            # auth=password 时
export MCPGW_SSH_KEY=/path/to/id_ed25519   # auth=key 时
export MCPGW_SSH_PASSPHRASE='...'     # 私钥口令（可选）
```

**方式 C：手工写 config.json**

```json
{
  "pollIntervalMs": 8000,
  "ssh": {
    "host": "203.0.113.10",
    "port": 22,
    "user": "root",
    "auth": "password",
    "password": "<DPAPI 密文，或留空用环境变量>"
  }
}
```

> 旧版本的明文 `password` 会被自动识别并迁移为 DPAPI 密文（`crypto-store.js`）。

### 安全设计要点

1. **DPAPI（CurrentUser）**：密文绑定当前 Windows 用户，其他账户/机器无法解密。
2. **凭据不落命令行**：SSH 连接经 `ssh-exec.py` 从环境变量读凭据，`ps` 看不到密码。
3. **面板 HTTP 仅 loopback**：路由 `guard()` 只允许 `127.0.0.1` / `::1` 访问。
4. **命令注入防护**：容器 ID、镜像名、端口、路径等均经白名单正则校验后才拼进远端命令。

### 若曾误提交凭据

- 立即在远端平台（GitHub 等）**删除该仓库**（或清除历史）。
- 同时**更换泄露的密码**——任何进入过版本库的凭据都应视为已泄露。
- 本仓库从创建起就未跟踪过任何配置/凭据文件（见 `.gitignore`）。
