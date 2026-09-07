# dsh-docker

> DeepSeek Harness (DSH) Web plugin · Docker Management Panel (Docker MCP Gateway management + container/image management)

`dsh-docker` (plugin id: `dsh-docker`) is a sidebar **Docker** panel plugin for the DeepSeek Harness Web GUI. It unifies two categories of Docker operations into a single build-free web panel:

- **Docker MCP management**: view/deploy/remove MCP servers in profiles, search/pull from the official Docker MCP Catalog, start/stop/restart the MCP Gateway, custom deployments (remote https or local images)
- **Container & image management**: container list/start/stop/restart/remove/logs/inspect/interactive terminal, prune stopped containers, create containers, pull/build/load/run images

Supports **multiple management targets**: switch between **Local CLI** and **SSH remote server** — all tabs (MCP / containers / images) then operate against the currently selected target.

---

## ✨ Features

### Multi-target management
- Target selector at the top of the panel; switch management target with one click
- **Local target**: executes `docker` / `docker mcp` commands directly on this machine; container operations connect to the daemon via the current docker context
- **SSH target**: executes `docker mcp` CLI on the remote host over a persistent paramiko SSH connection, managing the remote Docker Engine and MCP servers

### Docker MCP management (MCP tab)
- View deployed MCP servers (servers in a profile)
- Deploy / remove MCP servers (`docker mcp`)
- Search / pull from the official **Docker MCP Catalog** (300+ MCP servers)
- Start / stop / restart the **MCP Gateway** (persistent process that launches server containers on demand)
- **Custom deployment**: remote https MCP endpoint, or a local image (non-self-describing images like `mcp/sqlite` must first `docker pull` successfully; the gateway loads local images with `--pull never`)
- Profile management: create / delete profiles

### Container & image management (Containers tab)
- Containers: list / start / stop / restart / remove / logs / inspect / interactive terminal (`docker exec -it`, SSH targets only) / prune stopped containers
- Create container: `docker run` with ports, environment variables, volumes, and command arguments; "keep running" is enabled by default (appends `tail -f /dev/null` automatically when no command is given, preventing the container from exiting right after start)
- Images: pull / build (`docker build`) / load (`docker load`) / run
- Destructive operations (stop / restart / remove / prune) require a confirmation dialog

### Security design
- SSH authentication supports **password or private key**; credentials are stored **encrypted with Windows DPAPI** (only the current user can decrypt; never written in plaintext)
- Panel HTTP is restricted to **loopback** (127.0.0.1 / ::1) only
- Command injection protection: container IDs, image names, ports, and paths are validated against whitelist regexes before being composed into commands
- Credentials never appear on the command line: the SSH connection reads them from environment variables inside a Python subprocess

### Engineering highlights
- **Build-free**: both Host and Client halves are pure ESM JavaScript; the Client is zero-dependency pure DOM
- Config precedence: environment variables > `config.json` > inline cordis config
- Zero credentials in the repository: all connection info is configured locally by each user and never enters the repo

---

## 🏗️ Architecture

```
┌──────────────────── DSH Web GUI (browser) ────────────────────┐
│ lib/client.js (pure DOM, zero-dependency)                        │
│   sidebar "Docker" ⇄ MCP / containers / images tabs + target     │
│   switching + interactive terminal                               │
└──────────────────────────┬────────────────────────────────────┘
                           │ same-origin HTTP (loopback-only)
┌──────────────────────────▼────────────────────────────────────┐
│ DSH Host · lib/index.js                                          │
│   McpGatewayBoardService: multi-target dispatch + MCP/Gateway +  │
│   Docker operations                                             │
│   GET /api/dsh-docker/{state,catalog}                     │
│   POST /api/dsh-docker/{action,shell/*}                   │
│   config ~/.dsh/dsh-docker/config.json                    │
└──────────┬──────────────────────────────┬──────────────────────┘
           │ local                        │ ssh (persistent paramiko)
    ┌──────▼──────┐                ┌──────▼──────┐
    │ local docker│                │ remote Docker│  docker mcp profile/catalog/gateway
    │ context     │                │ Engine       │  MCP servers in containers
    └─────────────┘                └──────────────┘
```

### Module responsibilities

| Module | Responsibility |
|---|---|
| `lib/index.js` | Host entry: config resolution, service mounting, system-prompt injection |
| `lib/host-service.js` | Core service: multi-target management, MCP/Gateway operations, Docker container/image operations, snapshot polling |
| `lib/host-routes.js` | HTTP routes (loopback-only): state / catalog / action / shell endpoints |
| `lib/client.js` | Frontend UI: panel, target switching, MCP/container/image tabs, interactive terminal |
| `lib/ssh-service.js` | SSH execution service: spawns persistent `ssh-exec.py`, one-JSON-per-line protocol |
| `lib/ssh-exec.py` | Persistent paramiko SSH process: command execution + PTY interactive terminal |
| `lib/local-exec.js` | Local docker execution: `execFile` + shell-style argument parsing (injection-safe) |
| `lib/local-db.js` | Reads/writes `working_set` in the local `~/.docker/mcp/mcp-toolkit.db` (node:sqlite) |
| `lib/crypto-store.js` | Windows DPAPI credential encryption (ProtectedData · CurrentUser) |
| `scripts/wsl-docker-setup.sh` | One-shot WSL2 Ubuntu Docker Engine + docker mcp installer (with Tsinghua mirror fallback) |

---

## 📦 Installation

### Method 1: dsh CLI (recommended)

```bash
# <repo-path> is the cloned/extracted plugin directory
dsh plugin --profile web add link:<repo-path>
dsh web
```

### Method 2: Manual setup

1. Add to `dependencies` in `~/.dsh/profiles/web/package.json`:

   ```json
   "dsh-docker": "file:<repo-path>"
   ```

2. Append `dsh-docker` to the `dsh.profile.bundles` array
3. Keep this entry in `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: dsh-docker
         name: 'dsh-docker'
   ```

4. Run `npm install` in the profile directory and restart `dsh web`

After installation a **Docker** entry appears in the sidebar.

---

## ⚙️ Configuration

Config precedence: **environment variables > `~/.dsh/dsh-docker/config.json` > inline cordis config**

### Environment variables

| Variable | Description |
|---|---|
| `MCPGW_SSH_HOST` | SSH host |
| `MCPGW_SSH_PORT` | SSH port (default 22) |
| `MCPGW_SSH_USER` | SSH user |
| `MCPGW_SSH_PWD` | SSH password (prefer env; do not write into config.json) |
| `MCPGW_SSH_AUTH` | Auth method: `password` (default) or `key` |
| `MCPGW_SSH_KEY` | Private key path (used with auth=key) |
| `MCPGW_SSH_PASSPHRASE` | Private key passphrase (optional) |

### Runtime config (`~/.dsh/dsh-docker/config.json`, in your home dir — never commit to git)

```json
{
  "pollIntervalMs": 8000,
  "activeTargetId": "remote",
  "targets": [
    {
      "id": "local",
      "name": "Local Docker",
      "type": "local",
      "dockerPath": ""
    },
    {
      "id": "remote",
      "name": "Remote server",
      "type": "ssh",
      "ssh": {
        "host": "203.0.113.10",
        "port": 22,
        "user": "root",
        "auth": "password",
        "password": "<DPAPI ciphertext, or leave empty to use env vars>"
      }
    }
  ]
}
```

> Legacy single `ssh` config is automatically migrated into an SSH target in the `targets` array.

### Recommended setup

1. **Plugin "Connection Settings" dialog** (recommended): sidebar "Docker" → settings (top-right) → fill SSH host/port/user, choose password or key auth, save. The password is stored encrypted with DPAPI and never echoed back.
2. **Environment variables**: best for scripts/CI; nothing written to disk.
3. **Manual config.json**: as in the example above.

---

## 🖥️ Usage

### Panel layout

- **Top bar**: management target selector (local / SSH remote) + connection status indicator + settings button
- **MCP tab**: two sub-pages — deployed / catalog
  - Deployed: view MCP servers in profiles; deploy/remove
  - Catalog: search the official Docker MCP Catalog; one-click deploy
- **Containers tab**: two sub-pages — containers (ps) / images
  - Containers: list, start/stop/restart, remove, logs, inspect, open terminal, prune stopped containers, create container
  - Images: pull, build, load, run

### Interactive container terminal (SSH targets only)

1. Click "Terminal" in the container list
2. An interactive `docker exec -it <container> sh` shell (PTY) opens inside the panel
3. Real-time I/O, window resize, and session close are supported

### Custom MCP deployment

- **Remote https endpoint**: fill in the MCP server URL directly
- **Local image**: first `docker pull <image>` locally, then fill in the image reference; the gateway loads local images with `--pull never`
- After writing to the target profile's working_set, **restart the gateway** to apply (one-click restart in the panel, automatically using `--verify-signatures=false` to work around Docker Hub CDN access issues for signature verification)

---

## 🔒 Security

| Info | Stored where | Enters the repo? |
|---|---|---|
| SSH host/port/user | `config.json` (home dir) or env vars | ❌ |
| SSH password | DPAPI ciphertext (only current user can decrypt) | ❌ |
| Private key path/passphrase | `config.json` | ❌ |
| Non-sensitive config (poll interval, etc.) | `config.json` | ❌ |

- `config.json` is excluded by both `.gitignore` and `.npmignore`; it has never been and will never be committed
- All examples in the code use generic placeholders (`203.0.113.10`, `root`, etc.) that do not represent any real environment
- Panel HTTP is loopback-only; destructive operations require confirmation; command injection is blocked by whitelist validation

See [SECURITY.md](SECURITY.md).

---

## 🗂️ Project structure

```
dsh-docker/
├── lib/
│   ├── index.js            # Host entry (config resolution, service mounting)
│   ├── host-service.js     # Core service (multi-target, MCP, Gateway, Docker ops)
│   ├── host-routes.js      # HTTP routes (loopback-only)
│   ├── client.js           # Frontend UI (pure DOM, build-free)
│   ├── ssh-service.js      # SSH execution service (spawns python)
│   ├── ssh-exec.py         # Persistent paramiko SSH process (commands + PTY)
│   ├── local-exec.js       # Local docker execution
│   ├── local-db.js         # Local sqlite working_set operations
│   └── crypto-store.js     # DPAPI credential encryption
├── scripts/
│   └── wsl-docker-setup.sh # WSL2 Docker one-shot installer
├── cordis.patch.yml        # Plugin registration patch
├── package.json
├── README.md               # 中文文档
└── README.en.md            # This document (English)
```

---

## 🛠️ Development

- **Build-free**: edit `lib/*.js` directly; restart `dsh web` after Host-side changes, hard-refresh the browser (Ctrl+F5) after Client-side changes
- Host syntax check: `node --check lib/*.js`
- Remote prerequisites:
  - Docker Engine + `docker-mcp` CLI plugin (`~/.docker/cli-plugins/docker-mcp`)
  - `export DOCKER_MCP_IN_CONTAINER=1` (when Docker Desktop is unavailable)
  - `docker mcp feature enable profiles`
  - `docker mcp catalog pull mcp/docker-mcp-catalog`
  - Python 3 + `paramiko` on the local machine (for `ssh-exec.py`)

---

## 📄 License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
