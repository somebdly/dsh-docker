window.__ModuleLoader__.load({
  id: "dsh-mcp-gateway-board",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // Client 插件（浏览器端）：纯 DOM + fetch，零依赖、零 import，免构建。
    // 挂载两处界面：侧边栏入口行 + 中心列看板视图；通过同源 fetch 调 Host 路由。

    const inject = []

    const API = '/api/mcp-gateway-board'
    const ENTRY_ATTR = 'data-dsh-mcp-gateway-board-entry'
    const ENTRY_SELECTOR = `[${ENTRY_ATTR}]`
    const VIEW_ATTR = 'data-dsh-mcp-gateway-board-view'
    const VIEW_SELECTOR = `[${VIEW_ATTR}]`
    const ACTIVE_ATTR = 'data-dsh-mcp-gateway-board-active'
    const SSH_ACTIVE_ATTR = 'data-dsh-ssh-active'
    const ACTIVATE_EVENT = 'dsh-panel-activate'
    const PANEL_NAME = 'mcp-gateway-board'

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    }

    function num(n) {
      const v = Number(n)
      return Number.isFinite(v) ? v : 0
    }

    function fmtNum(n) {
      const v = num(n)
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M'
      if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
      return String(v)
    }

    let applied = false

    function apply(ctx) {
      if (applied) return
      applied = true

      ctx.effect(() => {
        const state = {
          open: false,
          tab: 'mcp',
          mview: 'deployed',
          search: '',
          profile: '',
          snapshot: null,
          pollTimer: null,
          busy: false,
        }
        const disposers = []

        const cleanup = () => {
          for (const d of disposers.splice(0)) {
            try { d() } catch { /* ignore */ }
          }
          applied = false
        }

        disposers.push(injectStyle())

        // ---- 侧边栏入口 ----
        disposers.push(mountEntry(() => toggle(state)))

        // ---- 看板容器 ----
        disposers.push(mountBoard())

        // ---- 轮询 + 可见性刷新 ----
        const refresh = async () => {
          try {
            const res = await fetch(`${API}/state`, { cache: 'no-store' })
            state.snapshot = await res.json()
          } catch (error) {
            state.snapshot = {
              connected: false,
              error: error instanceof Error ? error.message : String(error),
              profiles: [],
              servers: [],
              catalogServers: [],
              gateway: { running: false },
              updatedAt: Date.now(),
            }
          }
          // 若尚未选择 profile，默认选第一个
          if (state.profile === '') {
            const profiles = state.snapshot?.profiles || []
            state.profile = profiles.length > 0 ? (profiles[0].id || profiles[0].name) : ''
          }
          render(state)
        }

        const startPoll = () => {
          stopPoll()
          const interval = Number(state.snapshot?.config?.pollIntervalMs) || 8000
          state.pollTimer = setInterval(() => { void refresh() }, Math.max(3000, interval))
        }
        const stopPoll = () => {
          if (state.pollTimer !== null) {
            clearInterval(state.pollTimer)
            state.pollTimer = null
          }
        }

        const toggle = (st) => {
          st.open = !st.open
          if (st.open) {
            document.documentElement.removeAttribute(SSH_ACTIVE_ATTR)
            document.documentElement.setAttribute(ACTIVE_ATTR, '')
            document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
            void refresh()
            startPoll()
          } else {
            document.documentElement.removeAttribute(ACTIVE_ATTR)
            stopPoll()
          }
        }

        const onOtherActivate = (event) => {
          // 任何其它面板（ssh / taskagent / 任意 panel）激活时，关闭自己，保证互斥
          if (event.detail !== PANEL_NAME && state.open) {
            state.open = false
            document.documentElement.removeAttribute(ACTIVE_ATTR)
            stopPoll()
          }
        }
        document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
        disposers.push(() => document.removeEventListener(ACTIVATE_EVENT, onOtherActivate))

        const SIDEBAR_ROW_SELECTOR =
          '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
        const onClickSidebarRow = (event) => {
          if (!state.open) return
          const target = event.target
          if (target === null) return
          if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) {
            state.open = false
            document.documentElement.removeAttribute(ACTIVE_ATTR)
            stopPoll()
          }
        }
        document.addEventListener('click', onClickSidebarRow, true)
        disposers.push(() => document.removeEventListener('click', onClickSidebarRow, true))

        const onVisibility = () => {
          if (state.open && document.visibilityState === 'visible') void refresh()
        }
        document.addEventListener('visibilitychange', onVisibility)
        disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))

        // ---- 动作 ----
        async function postAction(action) {
          const res = await fetch(`${API}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action),
          })
          const data = await res.json()
          if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 ${res.status}`)
          return data
        }

        async function doAction(action) {
          if (state.busy) return undefined
          state.busy = true
          try {
            const data = await postAction(action)
            if (data && data.snapshot) state.snapshot = data.snapshot
            render(state)
            return data
          } catch (error) {
            showModal(modalHtml('操作失败', `<p class="mcp-err">${esc(error instanceof Error ? error.message : String(error))}</p>`))
          } finally {
            state.busy = false
          }
          return undefined
        }

        // ---- 渲染 ----
        function render(st) {
          const view = document.querySelector(VIEW_SELECTOR)
          if (view === null) return
          const snap = st.snapshot || { connected: false, profiles: [], servers: [], catalogServers: [], gateway: {} }
          view.innerHTML = boardHtml(snap, st)
          bindBoard(view, st)
        }

        function boardHtml(snap, st) {
          const connected = Boolean(snap.connected)
          const sshOk = Boolean(snap.ssh && snap.ssh.connected)
          const gw = snap.gateway || {}
          const gwRunning = Boolean(gw.running)
          const profiles = Array.isArray(snap.profiles) ? snap.profiles : []
          const servers = Array.isArray(snap.servers) ? snap.servers : []
          const catalog = Array.isArray(snap.catalogServers) ? snap.catalogServers : []
          const catMeta = snap.catalog || {}

          const statusDot = connected ? 'mcp-ok' : 'mcp-err'
          const sshDot = sshOk ? 'mcp-ok' : 'mcp-err'
          const gwDot = gwRunning ? 'mcp-ok' : 'mcp-warn'

          const header =
            `<div class="mcp-header">` +
            `<div class="mcp-title">Docker 管理</div>` +
            `<div class="mcp-status">` +
            `<span class="mcp-dot ${sshDot}"></span><span>SSH${sshOk ? '已连接' : '未连接'}</span>` +
            `<span class="mcp-dot ${gwDot}"></span><span>Gateway${gwRunning ? `运行中:${gw.port || '?'}` : '已停止'}</span>` +
            (catMeta.serverCount ? `<span class="mcp-dot mcp-ok"></span><span>仓库 ${catMeta.serverCount}</span>` : '') +
            `</div>` +
            `<div class="mcp-header-actions">` +
            `<button class="mcp-btn" data-act="refresh">刷新</button>` +
            `<button class="mcp-btn" data-act="settings">设置</button>` +
            (gwRunning ? `<button class="mcp-btn" data-act="gateway-restart">重启 Gateway</button>` : '') +
            `</div>` +
            `</div>`

          if (!connected) {
            const err = snap.error || snap.ssh?.error || '未知错误'
            return header +
              `<div class="mcp-empty mcp-err">连接失败：${esc(err)}</div>` +
              `<div class="mcp-hint">请点击「设置」配置 SSH 连接（host/user/password），确保远端服务器已安装 docker mcp CLI。</div>`
          }

          const tabs =
            `<div class="mcp-tabs">` +
            `<button class="mcp-tab ${st.tab === 'mcp' ? 'mcp-tab-active' : ''}" data-act="tab-mcp">MCP</button>` +
            `<button class="mcp-tab ${st.tab === 'containers' ? 'mcp-tab-active' : ''}" data-act="tab-containers">容器</button>` +
            `</div>`

          const body = st.tab === 'containers'
            ? containersHtml(snap, st)
            : mcpHtml(snap, st)

          const footer =
            `<div class="mcp-footer">` +
            `<span>更新于 ${new Date(snap.updatedAt || Date.now()).toLocaleTimeString()}</span>` +
            `</div>`

          return header + tabs + body + footer
        }

        function mcpHtml(snap, st) {
          const servers = Array.isArray(snap.servers) ? snap.servers : []
          const catalog = Array.isArray(snap.catalogServers) ? snap.catalogServers : []
          const mview = st.mview || 'deployed'
          const subTabs =
            `<div class="mcp-subtabs">` +
            `<button class="mcp-subtab ${mview === 'deployed' ? 'mcp-subtab-active' : ''}" data-act="mview-deployed">已部署 (${servers.length})</button>` +
            `<button class="mcp-subtab ${mview === 'catalog' ? 'mcp-subtab-active' : ''}" data-act="mview-catalog">仓库 (${catalog.length})</button>` +
            `</div>`
          const content = mview === 'catalog'
            ? catalogHtml(snap, st)
            : deployedHtml(snap, st)
          return subTabs + content
        }

        function deployedHtml(snap, st) {
          const profiles = Array.isArray(snap.profiles) ? snap.profiles : []
          const servers = Array.isArray(snap.servers) ? snap.servers : []

          const profileOptions = profiles.map((p) =>
            `<option value="${esc(p.id || p.name)}" ${st.profile === (p.id || p.name) ? 'selected' : ''}>${esc(p.name || p.id)} (${p.serverCount})</option>`
          ).join('')

          const profileBar =
            `<div class="mcp-bar">` +
            `<label class="mcp-field-inline"><span>Profile</span>` +
            `<select id="mcp-profile" class="mcp-input mcp-select" data-act="select-profile">` +
            (profiles.length === 0 ? `<option value="">(无 profile)</option>` : profileOptions) +
            `</select></label>` +
            `<button class="mcp-btn mcp-primary" data-act="new-profile">＋ 新建 profile</button>` +
            `<button class="mcp-btn" data-act="deploy-custom">＋ 自定义部署</button>` +
            `<button class="mcp-btn mcp-danger-ghost" data-act="remove-profile">删除 profile</button>` +
            `</div>`

          if (profiles.length === 0) {
            return profileBar +
              `<div class="mcp-empty">还没有部署任何 MCP。</div>` +
              `<div class="mcp-hint">新建 profile 后，到「仓库」tab 搜索并部署 MCP。</div>`
          }

          // 按当前所选 profile 过滤服务器列表（切换 profile 下拉即切换视图）。
          const visible = st.profile === ''
            ? servers
            : servers.filter((s) => (s.profile || '') === st.profile)

          if (visible.length === 0) {
            return profileBar +
              `<div class="mcp-empty">当前 profile 还没有部署 MCP。</div>` +
              `<div class="mcp-hint">到「仓库」tab 搜索并部署 MCP。</div>`
          }

          const cards = visible.map((s) => {
            const toolCount = num(s.toolCount)
            return (
              `<div class="mcp-card">` +
              `<div class="mcp-card-head">` +
              `<span class="mcp-card-name">${esc(s.title || s.name)}</span>` +
              `<span class="mcp-badge">${esc(s.profile || '')}</span>` +
              `</div>` +
              `<div class="mcp-card-desc">${esc(s.description || '')}</div>` +
              (s.endpoint ? `<div class="mcp-card-endpoint" title="endpoint">${esc(s.endpoint)}</div>` : '') +
              `<div class="mcp-card-meta">` +
              `<span class="mcp-meta">${esc(s.name)}</span>` +
              (toolCount > 0 ? `<span class="mcp-meta">tools=${toolCount}</span>` : '') +
              `</div>` +
              `<div class="mcp-card-actions">` +
              `<button class="mcp-btn mcp-danger" data-act="remove" data-name="${esc(s.name)}" data-profile="${esc(s.profile || '')}">移除</button>` +
              `</div>` +
              `</div>`
            )
          }).join('')

          return profileBar + `<div class="mcp-grid">${cards}</div>`
        }

        // ---- 容器管理 ----
        function containerState(c) {
          const st = String(c.State || '')
          if (st === 'running') return 'mcp-ok'
          if (st === 'exited' || st === 'dead') return 'mcp-err'
          if (st === 'paused') return 'mcp-warn'
          return 'mcp-warn'
        }

        function containersHtml(snap, st) {
          const containers = Array.isArray(snap.containers) ? snap.containers : []
          const images = Array.isArray(snap.images) ? snap.images : []
          const cview = st.cview || 'ps'

          const viewSwitch =
            `<div class="mcp-bar">` +
            `<button class="mcp-btn ${cview === 'ps' ? 'mcp-primary' : ''}" data-act="cview-ps">容器 (${containers.length})</button>` +
            `<button class="mcp-btn ${cview === 'images' ? 'mcp-primary' : ''}" data-act="cview-images">镜像 (${images.length})</button>` +
            (cview === 'ps'
              ? `<button class="mcp-btn mcp-primary" data-act="docker-run">新建容器</button>` +
                `<button class="mcp-btn mcp-danger-ghost" data-act="docker-prune">清理停止容器</button>`
              : `<button class="mcp-btn" data-act="docker-pull">拉取镜像</button>` +
                `<button class="mcp-btn" data-act="docker-build">构建镜像</button>` +
                `<button class="mcp-btn" data-act="docker-load">导入镜像</button>`) +
            `</div>`

          if (cview === 'images') {
            if (images.length === 0) {
              return viewSwitch + `<div class="mcp-empty">暂无镜像。</div>` +
                `<div class="mcp-hint">可「拉取镜像」从仓库获取，「构建镜像」从 Dockerfile 构建，或「导入镜像」从 tar 文件加载。</div>`
            }
            const rows = images.map((im) => {
              const size = im.Size || ''
              const tag = im.Tag || ''
              const repo = im.Repository || ''
              const fullName = tag ? `${repo}:${tag}` : repo
              return (
                `<tr>` +
                `<td class="mcp-td-name" title="${esc(repo)}">${esc(repo)}</td>` +
                `<td>${esc(tag)}</td>` +
                `<td>${esc(size)}</td>` +
                `<td>${esc(im.ID ? im.ID.slice(0, 19) : '')}</td>` +
                `<td class="mcp-cell-actions">` +
                `<button class="mcp-btn mcp-mini" data-act="docker-run" data-image="${esc(fullName)}">新建容器</button>` +
                `</td>` +
                `</tr>`
              )
            }).join('')
            return viewSwitch +
              `<div class="mcp-table-wrap"><table class="mcp-table">` +
              `<thead><tr><th>镜像</th><th>标签</th><th>大小</th><th>ID</th><th>操作</th></tr></thead>` +
              `<tbody>${rows}</tbody></table></div>`
          }

          if (containers.length === 0) {
            return viewSwitch + `<div class="mcp-empty">暂无容器。</div>` +
              `<div class="mcp-hint">容器列表来自远端 docker ps -a。</div>`
          }
          const rows = containers.map((c) => {
            const id = c.ID || c.Id || ''
            const shortId = String(id).slice(0, 12)
            // docker ps --format json: Names 是逗号分隔字符串（首个为主名）
            const namesRaw = c.Names || c.name || ''
            const names = String(namesRaw).split(',').map((n) => n.replace(/^\//, ''))
            const name = (names[0] || shortId)
            const image = c.Image || ''
            const status = c.Status || ''
            const state = c.State || ''
            const portStr = c.Ports || ''
            return (
              `<tr>` +
              `<td class="mcp-td-name" title="${esc(id)}">${esc(name)}</td>` +
              `<td><span class="mcp-dot ${containerState(c)}"></span>${esc(status)}</td>` +
              `<td title="${esc(image)}">${esc(String(image).length > 40 ? String(image).slice(0, 40) + '…' : image)}</td>` +
              `<td title="${esc(portStr)}">${esc(String(portStr).length > 40 ? String(portStr).slice(0, 40) + '…' : portStr)}</td>` +
              `<td><span class="mcp-mono">${esc(shortId)}</span></td>` +
              `<td class="mcp-cell-actions">` +
              `<button class="mcp-btn mcp-mini" data-act="docker-start" data-id="${esc(id)}" ${state === 'running' ? 'disabled' : ''}>启动</button>` +
              `<button class="mcp-btn mcp-mini" data-act="docker-stop" data-id="${esc(id)}" ${state !== 'running' ? 'disabled' : ''}>停止</button>` +
              `<button class="mcp-btn mcp-mini" data-act="docker-restart" data-id="${esc(id)}">重启</button>` +
              `<button class="mcp-btn mcp-mini" data-act="docker-log" data-id="${esc(id)}">日志</button>` +
              `<button class="mcp-btn mcp-mini" data-act="docker-shell" data-id="${esc(id)}" ${state !== 'running' ? 'disabled' : ''}>终端</button>` +
              `<button class="mcp-btn mcp-mini" data-act="docker-inspect" data-id="${esc(id)}">详情</button>` +
              `<button class="mcp-btn mcp-mini mcp-danger" data-act="docker-rm" data-id="${esc(id)}">删除</button>` +
              `</td>` +
              `</tr>`
            )
          }).join('')
          return viewSwitch +
            `<div class="mcp-table-wrap"><table class="mcp-table">` +
            `<thead><tr><th>名称</th><th>状态</th><th>镜像</th><th>端口</th><th>ID</th><th>操作</th></tr></thead>` +
            `<tbody>${rows}</tbody></table></div>`
        }

        async function doDockerLog(st, id) {
          const data = await doAction({ kind: 'docker', op: 'logs', targets: [id], tail: 200 })
          if (data) {
            showModal(modalHtml('容器日志', `<div class="mcp-log"><pre>${esc(data.output || '(空)')}</pre></div>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
          }
        }

        async function doDockerInspect(st, id) {
          const data = await doAction({ kind: 'docker', op: 'inspect', targets: [id] })
          if (data && data.data) {
            const pretty = JSON.stringify(data.data, null, 2).slice(0, 4000)
            showModal(modalHtml('容器详情', `<div class="mcp-log"><pre>${esc(pretty)}</pre></div>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
          }
        }

        // ---- 交互式容器终端（docker exec -it）----
        // 输出：SSE 流（/shell/stream）；输入：POST /shell/input（按键字节）

        let termStreamCtrl = null // 当前终端 SSE AbortController
        let termKeyHandler = null // 当前终端键盘监听器
        let termSession = '' // 当前终端会话 id

        async function doDockerShell(st, id) {
          // 关闭上一个终端（若有）
          if (termStreamCtrl) {
            try {
              termStreamCtrl.abort()
            } catch {
              /* ignore */
            }
            termStreamCtrl = null
          }
          if (termKeyHandler) {
            document.removeEventListener('keydown', termKeyHandler, true)
            termKeyHandler = null
          }
          let data
          try {
            const resp = await fetch(`${API}/shell/open`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ container: id, shell: 'sh' }),
            })
            data = await resp.json()
          } catch (error) {
            showModal(modalHtml('终端', `<p class="mcp-err">连接失败：${esc(error.message || String(error))}</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
            return
          }
          if (!data || !data.ok) {
            showModal(modalHtml('终端', `<p class="mcp-err">${esc((data && data.error) || '打开会话失败')}</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
            return
          }
          const session = data.session
          termSession = session
          const body =
            `<div class="mcp-term-wrap">` +
            `<pre id="mcp-term-out" class="mcp-term" tabindex="0">${session ? `连接已建立（session ${esc(session.slice(0, 16))}）…` : ''}</pre>` +
            `</div>` +
            `<p class="mcp-hint">点击终端区域后键入命令。Enter=执行，Ctrl+C=中断，Ctrl+D=退出（exit），Backspace=删除。</p>` +
            `<div class="mcp-modal-actions">` +
            `<button class="mcp-btn mcp-danger" data-act="shell-close">关闭终端</button>` +
            `</div>`
          showModal(modalHtml(`终端：${esc(String(id).slice(0, 12))}`, body, true))

          const outEl = document.getElementById('mcp-term-out')
          if (outEl) {
            outEl.textContent = ''
            outEl.focus()
          }

          // SSE 输出流
          const ctrl = new AbortController()
          termStreamCtrl = ctrl
          const stream = fetch(`${API}/shell/stream?session=${encodeURIComponent(session)}`, { signal: ctrl.signal })
          stream.then((resp) => {
            if (!resp.ok || !resp.body) {
              appendTerm('（流连接失败）')
              return
            }
            const reader = resp.body.getReader()
            const decoder = new TextDecoder('utf-8')
            let buf = ''
            const pump = () => {
              reader.read().then(({ done, value }) => {
                if (done) {
                  appendTerm('（终端已断开）')
                  return
                }
                buf += decoder.decode(value, { stream: true })
                let idx
                while ((idx = buf.indexOf('\n\n')) !== -1) {
                  const frame = buf.slice(0, idx)
                  buf = buf.slice(idx + 2)
                  if (frame.startsWith('data: ')) {
                    try {
                      const ev = JSON.parse(frame.slice(6))
                      if (ev.type === 'data' && typeof ev.data === 'string') appendTerm(ev.data)
                      else if (ev.type === 'exit') appendTerm(`\r\n[进程已退出，exit=${ev.exit}]`)
                    } catch {
                      /* ignore */
                    }
                  }
                }
                pump()
              }).catch(() => {
                /* aborted */
              })
            }
            pump()
          }).catch(() => {
            /* aborted */
          })

          // 键盘输入
          const keyHandler = (e) => {
            if (e.defaultPrevented) return
            // 忽略带修饰键的组合（Ctrl 仅处理 C/D/C，Alt/Meta 忽略）
            if (e.ctrlKey || e.metaKey || e.altKey) {
              if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                const ch = e.key.toLowerCase()
                if (ch === 'c') { e.preventDefault(); sendTerm(session, '\x03'); return }
                if (ch === 'd') { e.preventDefault(); sendTerm(session, '\x04'); return }
              }
              return
            }
            if (e.key === 'Enter') { e.preventDefault(); sendTerm(session, '\r'); return }
            if (e.key === 'Backspace') { e.preventDefault(); sendTerm(session, '\x7f'); return }
            if (e.key === 'Tab') { e.preventDefault(); sendTerm(session, '\t'); return }
            if (e.key.length === 1) {
              e.preventDefault()
              sendTerm(session, e.key)
              return
            }
            // 方向键等：发送 ANSI 转义序列
            const map = {
              ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
              Home: '\x1b[H', End: '\x1b[F',
            }
            if (map[e.key]) { e.preventDefault(); sendTerm(session, map[e.key]); return }
          }
          document.addEventListener('keydown', keyHandler, true)
          termKeyHandler = keyHandler
        }

        function stripAnsi(text) {
          // 剔除 ANSI 转义序列（颜色/光标/清屏/标题等），保留可打印文本。
          // 极简终端不做颜色渲染，剔除后输出干净可读。
          return String(text)
            .replace(/\x1b\][^\x07]*\x07/g, '') // OSC（终端标题等）
            .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI（颜色/光标/清屏）
            .replace(/\x1b[()][A-Z0-9]/g, '') // 字符集选择
            .replace(/\x1b[=>]/g, '')
            .replace(/\x1b[78]/g, '')
        }

        function appendTerm(text) {
          const outEl = document.getElementById('mcp-term-out')
          if (!outEl) return
          outEl.textContent += stripAnsi(text)
          // 限制长度，防内存膨胀
          if (outEl.textContent.length > 200000) {
            outEl.textContent = outEl.textContent.slice(-150000)
          }
          outEl.scrollTop = outEl.scrollHeight
        }

        function sendTerm(session, data) {
          void fetch(`${API}/shell/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session, data }),
          }).catch(() => {
            /* ignore */
          })
        }

        async function doShellClose() {
          const session = termSession
          termSession = ''
          // 中断 SSE 流
          if (termStreamCtrl) {
            try {
              termStreamCtrl.abort()
            } catch {
              /* ignore */
            }
            termStreamCtrl = null
          }
          // 移除键盘监听
          if (termKeyHandler) {
            document.removeEventListener('keydown', termKeyHandler, true)
            termKeyHandler = null
          }
          // 通知后端关闭 PTY 会话
          if (session !== '') {
            void fetch(`${API}/shell/close`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session }),
            }).catch(() => {
              /* ignore */
            })
          }
          closeTopModal()
        }

        async function doDockerChange(st, op, id) {
          if (!id) return
          const opLabel = { start: '启动', stop: '停止', restart: '重启' }[op] || op
          const data = await doAction({ kind: 'docker', op, targets: [id] })
          if (data) {
            showModal(modalHtml(`${opLabel}完成`, `<p>已对容器执行 <b>${esc(op)}</b>。</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
          }
        }

        function confirmDocker(id, name, op, opLabel, danger) {
          const body =
            `<p>确定要 <b class="${danger ? 'mcp-text-danger' : ''}">${esc(opLabel)}</b> 容器 <b>${esc(name)}</b>（<span class="mcp-mono">${esc(String(id).slice(0, 12))}</span>）吗？</p>` +
            (danger ? `<p class="mcp-warn">⚠ 此操作不可撤销！${opLabel === '删除' ? '容器及其数据卷内容将被移除。' : '停止的容器可用「启动」恢复。'}</p>` : '') +
            `<div class="mcp-modal-actions">` +
            `<button class="mcp-btn" data-act="modal-close">取消</button>` +
            `<button class="mcp-btn mcp-danger" data-act="docker-op-confirm" data-id="${esc(id)}" data-op="${esc(op)}" data-label="${esc(opLabel)}">确认${esc(opLabel)}</button>` +
            `</div>`
          showModal(modalHtml('确认操作', body))
        }

        async function doDockerRm(st, id) {
          if (!id) return
          const data = await doAction({ kind: 'docker', op: 'rm', targets: [id], force: true })
          if (data) {
            showModal(modalHtml('删除完成', `<p>容器 <b>${esc(String(id).slice(0, 12))}</b> 已删除。</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
          }
        }

        async function doDockerPull(st) {
          const body =
            `<label class="mcp-field"><span>镜像名</span>` +
            `<input id="mcp-pull-image" class="mcp-input" placeholder="例如 nginx:latest"></label>` +
            `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="docker-pull-submit">拉取</button></div>`
          showModal(modalHtml('拉取镜像', body))
        }

        async function doDockerPullConfirm(st, image) {
          if (image === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">镜像名不能为空</p>'))
            return
          }
          const data = await doAction({ kind: 'docker', op: 'pull', targets: [image] })
          if (data) {
            closeTopModal()
            showModal(modalHtml('拉取完成', `<p class="mcp-dim">${esc(data.output || '(空)')}</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
          }
        }

        function doDockerBuild(st) {
          const body =
            `<label class="mcp-field"><span>镜像名:标签</span>` +
            `<input id="mcp-build-image" class="mcp-input" placeholder="例如 myapp:v1"></label>` +
            `<label class="mcp-field"><span>构建上下文路径（远端）</span>` +
            `<input id="mcp-build-context" class="mcp-input" placeholder="例如 /home/user/myapp 或 ."></label>` +
            `<label class="mcp-field"><span>Dockerfile 路径（可选，默认上下文内）</span>` +
            `<input id="mcp-build-dockerfile" class="mcp-input" placeholder="例如 /home/user/myapp/Dockerfile"></label>` +
            `<p class="mcp-dim">在远端服务器执行 docker build，耗时取决于镜像大小。</p>` +
            `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="docker-build-submit">开始构建</button></div>`
          showModal(modalHtml('构建镜像', body))
        }

        async function doDockerBuildConfirm(st) {
          const image = document.getElementById('mcp-build-image')?.value?.trim() ?? ''
          const context = document.getElementById('mcp-build-context')?.value?.trim() ?? ''
          const dockerfile = document.getElementById('mcp-build-dockerfile')?.value?.trim() ?? ''
          if (image === '' || context === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">镜像名和构建上下文路径不能为空</p>'))
            return
          }
          const data = await doAction({ kind: 'docker', op: 'build', targets: [image], context, dockerfile })
          if (data) {
            closeTopModal()
            showModal(modalHtml('构建结果', `<p class="mcp-dim">${esc(data.output || '(无输出)')}</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
          }
        }

        function doDockerLoad(st) {
          const body =
            `<label class="mcp-field"><span>镜像 tar 文件路径（远端）</span>` +
            `<input id="mcp-load-path" class="mcp-input" placeholder="例如 /home/user/myapp.tar"></label>` +
            `<p class="mcp-dim">执行 docker load -i，适用于 docker save 导出的镜像文件。</p>` +
            `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="docker-load-submit">导入</button></div>`
          showModal(modalHtml('导入镜像', body))
        }

        async function doDockerLoadConfirm(st) {
          const path = document.getElementById('mcp-load-path')?.value?.trim() ?? ''
          if (path === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">tar 文件路径不能为空</p>'))
            return
          }
          const data = await doAction({ kind: 'docker', op: 'load', targets: [path] })
          if (data) {
            closeTopModal()
            showModal(modalHtml('导入结果', `<p class="mcp-dim">${esc(data.output || '(无输出)')}</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
          }
        }

        async function doDockerRun(st, image) {
          // 确保镜像列表已加载（容器视图打开时可能未拉 images）
          if (!Array.isArray(st.snapshot?.images) || st.snapshot.images.length === 0) {
            const data = await doAction({ kind: 'docker', op: 'images' })
            if (data && Array.isArray(data.data)) st.snapshot.images = data.data
          }
          const images = Array.isArray(st.snapshot?.images) ? st.snapshot.images : []
          // 下拉选项：所有 <repo>:<tag>（去重，排除 <none>）
          const seen = new Set()
          const options = []
          for (const im of images) {
            const repo = im.Repository || ''
            const tag = im.Tag || ''
            if (repo === '' || repo === '<none>') continue
            const full = tag && tag !== '<none>' ? `${repo}:${tag}` : repo
            if (seen.has(full)) continue
            seen.add(full)
            options.push(full)
          }
          options.sort()
          const preselect = image || (options[0] || '')
          const selectOptions = options.map((o) => `<option value="${esc(o)}" ${o === preselect ? 'selected' : ''}>${esc(o)}</option>`).join('')
          const body =
            `<label class="mcp-field"><span>镜像</span>` +
            `<select id="mcp-run-image" class="mcp-input mcp-select">${selectOptions}</select></label>` +
            `<label class="mcp-field"><span>自定义镜像（可选，优先于下拉）</span>` +
            `<input id="mcp-run-image-custom" class="mcp-input" placeholder="例如 nginx:latest 或 myapp:v1"></label>` +
            `<label class="mcp-field"><span>容器名（可选）</span>` +
            `<input id="mcp-run-name" class="mcp-input" placeholder="例如 myapp（留空自动生成）"></label>` +
            `<label class="mcp-field"><span>端口映射（逗号分隔，可选）</span>` +
            `<input id="mcp-run-ports" class="mcp-input" placeholder="例如 8080:80, 127.0.0.1:3306:3306"></label>` +
            `<label class="mcp-field"><span>环境变量（逗号分隔，可选）</span>` +
            `<input id="mcp-run-env" class="mcp-input" placeholder="例如 APP_ENV=prod, TZ=Asia/Shanghai"></label>` +
            `<label class="mcp-field"><span>卷挂载（逗号分隔，可选）</span>` +
            `<input id="mcp-run-volumes" class="mcp-input" placeholder="例如 /data:/app/data, /tmp:/var/tmp:ro"></label>` +
            `<label class="mcp-field"><span>命令参数（空格分隔，可选，覆盖 CMD）</span>` +
            `<input id="mcp-run-cmd" class="mcp-input" placeholder="例如 --port 9000"></label>` +
            `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="docker-run-submit">创建容器</button></div>`
          showModal(modalHtml('新建容器', body))
        }

        async function doDockerRunConfirm(st) {
          const customImage = document.getElementById('mcp-run-image-custom')?.value?.trim() ?? ''
          const selectImage = document.getElementById('mcp-run-image')?.value ?? ''
          const image = customImage !== '' ? customImage : selectImage
          if (image === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">请选择或输入镜像名</p>'))
            return
          }
          const name = document.getElementById('mcp-run-name')?.value?.trim() ?? ''
          const portsStr = document.getElementById('mcp-run-ports')?.value?.trim() ?? ''
          const envStr = document.getElementById('mcp-run-env')?.value?.trim() ?? ''
          const volsStr = document.getElementById('mcp-run-volumes')?.value?.trim() ?? ''
          const cmdStr = document.getElementById('mcp-run-cmd')?.value?.trim() ?? ''
          const ports = portsStr === '' ? [] : portsStr.split(',').map((s) => s.trim()).filter(Boolean)
          const env = envStr === '' ? [] : envStr.split(',').map((s) => s.trim()).filter(Boolean)
          const volumes = volsStr === '' ? [] : volsStr.split(',').map((s) => s.trim()).filter(Boolean)
          const cmd = cmdStr === '' ? [] : cmdStr.split(/\s+/).filter(Boolean)
          const data = await doAction({ kind: 'docker', op: 'run', targets: [image], name, ports, env, volumes, cmd })
          if (data) {
            closeTopModal()
            showModal(modalHtml('创建结果', `<p class="mcp-dim">${esc(data.output || '(无输出)')}</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
          }
        }

        function findContainer(st, id) {
          const containers = Array.isArray(st.snapshot?.containers) ? st.snapshot.containers : []
          const c = containers.find((c) => (c.ID || c.Id || '') === id) || null
          if (!c) return null
          const names = Array.isArray(c.Names) ? c.Names : (c.name ? [c.name] : [])
          return { id: c.ID || c.Id || '', name: (names[0] || '').replace(/^\//, '') }
        }

        async function doDockerPrune(st) {
          const body =
            `<p>确定要清理所有 <b>已停止</b> 的容器吗？</p>` +
            `<p class="mcp-warn">⚠ 已停止的容器将被移除，无法恢复。</p>` +
            `<div class="mcp-modal-actions">` +
            `<button class="mcp-btn" data-act="modal-close">取消</button>` +
            `<button class="mcp-btn mcp-danger" data-act="docker-prune-confirm">确认清理</button>` +
            `</div>`
          showModal(modalHtml('清理停止容器', body))
        }

        function catalogHtml(snap, st) {
          const catalog = Array.isArray(snap.catalogServers) ? snap.catalogServers : []
          const q = (st.search || '').trim().toLowerCase()
          const list = q === ''
            ? catalog
            : catalog.filter((s) => `${s.name} ${s.title} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase().includes(q))

          const searchBar =
            `<div class="mcp-bar">` +
            `<label class="mcp-field-inline mcp-grow"><span>搜索</span>` +
            `<input id="mcp-search" class="mcp-input" type="text" placeholder="按名称/描述/标签搜索 MCP…" value="${esc(st.search)}"></label>` +
            `<button class="mcp-btn" data-act="refresh-catalog">刷新仓库</button>` +
            `<button class="mcp-btn" data-act="deploy-custom">＋ 自定义部署</button>` +
            `</div>`

          if (catalog.length === 0) {
            return searchBar +
              `<div class="mcp-empty">仓库尚未加载。</div>` +
              `<div class="mcp-hint">点击「刷新仓库」从 Docker MCP Catalog 拉取（约 314 个 MCP，首次较慢）。</div>`
          }

          if (list.length === 0) {
            return searchBar + `<div class="mcp-empty">没有匹配「${esc(st.search)}」的 MCP。</div>`
          }

          const cards = list.slice(0, 100).map((s) => {
            const toolCount = num(s.toolCount)
            const pulls = fmtNum(s.pulls)
            const stars = fmtNum(s.stars)
            return (
              `<div class="mcp-card">` +
              `<div class="mcp-card-head">` +
              `<span class="mcp-card-name">${esc(s.title || s.name)}</span>` +
              (s.category ? `<span class="mcp-badge">${esc(s.category)}</span>` : '') +
              `</div>` +
              `<div class="mcp-card-desc">${esc(s.description || '')}</div>` +
              `<div class="mcp-card-meta">` +
              `<span class="mcp-meta">${esc(s.name)}</span>` +
              (toolCount > 0 ? `<span class="mcp-meta">tools=${toolCount}</span>` : '') +
              (pulls !== '0' ? `<span class="mcp-meta">⬇ ${pulls}</span>` : '') +
              (stars !== '0' ? `<span class="mcp-meta">★ ${stars}</span>` : '') +
              `</div>` +
              `<div class="mcp-card-actions">` +
              `<button class="mcp-btn mcp-primary" data-act="deploy" data-name="${esc(s.name)}">部署</button>` +
              `</div>` +
              `</div>`
            )
          }).join('')

          const more = list.length > 100
            ? `<div class="mcp-hint">已显示前 100 个（共 ${list.length} 个），请用搜索缩小范围。</div>`
            : ''

          return searchBar + `<div class="mcp-grid">${cards}</div>` + more
        }

        // ---- 事件绑定 ----
        function bindBoard(view, st) {
          view.querySelectorAll('[data-act]').forEach((el) => {
            el.addEventListener('click', (event) => {
              const act = el.getAttribute('data-act')
              handleAct(act, el, st, event)
            })
          })
          const search = view.querySelector('#mcp-search')
          if (search) {
            search.addEventListener('input', (event) => {
              st.search = event.target.value
              render(st)
              const s2 = view.querySelector('#mcp-search')
              if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length) }
            })
          }
          const profileSel = view.querySelector('#mcp-profile')
          if (profileSel) {
            profileSel.addEventListener('change', (event) => {
              st.profile = event.target.value
              render(st)
            })
          }
        }

        async function handleAct(act, el, st, event) {
          switch (act) {
            case 'refresh':
              await refresh()
              break
            case 'settings':
              openSettings(st)
              break
            case 'tab-mcp':
              st.tab = 'mcp'
              render(st)
              break
            case 'mview-deployed':
              st.tab = 'mcp'
              st.mview = 'deployed'
              render(st)
              break
            case 'mview-catalog':
              st.tab = 'mcp'
              st.mview = 'catalog'
              render(st)
              break
            case 'deploy': {
              const name = el.getAttribute('data-name') || ''
              await deployServer(name, st)
              break
            }
            case 'remove': {
              const name = el.getAttribute('data-name') || ''
              const profile = el.getAttribute('data-profile') || ''
              await removeServer(name, profile, st)
              break
            }
            case 'new-profile':
              openNewProfile(st)
              break
            case 'remove-profile': {
              const profile = st.profile
              if (profile === '') { showModal(modalHtml('提示', '<p class="mcp-err">没有可删除的 profile</p>')); break }
              const data = await doAction({ kind: 'remove-profile', id: profile })
              if (data) { st.profile = ''; render(st) }
              break
            }
            case 'refresh-catalog':
              await doAction({ kind: 'refresh-catalog' })
              render(st)
              break
            case 'gateway-start':
              await doAction({ kind: 'gateway-start', profile: st.profile, port: 8080 })
              break
            case 'gateway-stop':
              await doAction({ kind: 'gateway-stop' })
              break
            case 'gateway-restart':
              confirmGatewayRestart(st)
              break
            case 'gateway-restart-confirm':
              await doGatewayRestart(st)
              break
            case 'deploy-custom':
              openDeployCustom(st)
              break
            case 'deploy-custom-submit':
              await submitDeployCustom(st)
              break
            case 'tab-containers':
              st.tab = 'containers'
              st.cview = st.cview || 'ps'
              render(st)
              void refresh()
              if (st.cview === 'ps') void doAction({ kind: 'docker', op: 'ps' })
              else void doAction({ kind: 'docker', op: 'images' })
              break
            case 'cview-ps':
              st.cview = 'ps'
              render(st)
              void doAction({ kind: 'docker', op: 'ps' })
              break
            case 'cview-images':
              st.cview = 'images'
              render(st)
              void doAction({ kind: 'docker', op: 'images' })
              break
            case 'docker-log': {
              const id = el.dataset.id || ''
              void doDockerLog(st, id)
              break
            }
            case 'docker-inspect': {
              const id = el.dataset.id || ''
              void doDockerInspect(st, id)
              break
            }
            case 'docker-shell': {
              const id = el.dataset.id || ''
              void doDockerShell(st, id)
              break
            }
            case 'shell-close':
              void doShellClose()
              break
            case 'docker-start':
              void doDockerChange(st, 'start', el.dataset.id)
              break
            case 'docker-stop': {
              const id = el.dataset.id || ''
              const c = findContainer(st, id)
              confirmDocker(id, c ? c.name : id, 'stop', '停止', false)
              break
            }
            case 'docker-restart': {
              const id = el.dataset.id || ''
              const c = findContainer(st, id)
              confirmDocker(id, c ? c.name : id, 'restart', '重启', false)
              break
            }
            case 'docker-rm': {
              const id = el.dataset.id || ''
              const c = findContainer(st, id)
              confirmDocker(id, c ? c.name : id, 'rm', '删除', true)
              break
            }
            case 'docker-op-confirm': {
              const id = el.dataset.id || ''
              const op = el.dataset.op || ''
              if (op === 'rm') void doDockerRm(st, id)
              else void doDockerChange(st, op, id)
              break
            }
            case 'docker-pull':
              void doDockerPull(st)
              break
            case 'docker-pull-submit': {
              const image = document.getElementById('mcp-pull-image')?.value?.trim() ?? ''
              void doDockerPullConfirm(st, image)
              break
            }
            case 'docker-build':
              doDockerBuild(st)
              break
            case 'docker-build-submit':
              void doDockerBuildConfirm(st)
              break
            case 'docker-load':
              doDockerLoad(st)
              break
            case 'docker-load-submit':
              void doDockerLoadConfirm(st)
              break
            case 'docker-run': {
              const image = el.dataset.image || ''
              void doDockerRun(st, image)
              break
            }
            case 'docker-run-submit':
              void doDockerRunConfirm(st)
              break
            case 'docker-prune':
              void doDockerPrune(st)
              break
            case 'docker-prune-confirm': {
              const data = await doAction({ kind: 'docker', op: 'prune' })
              if (data) {
                closeTopModal()
                showModal(modalHtml('清理完成', `<p>${esc(data.output || '已清理')}</p>` +
                  `<div class="mcp-modal-actions"><button class="mcp-btn" data-act="modal-close">关闭</button></div>`))
              }
              break
            }
            case 'settings-submit':
              await submitSettings(st)
              break
            case 'new-profile-submit':
              await submitNewProfile(st)
              break
            default:
              break
          }
        }

        async function deployServer(name, st) {
          if (st.profile === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">请先到「已部署」tab 新建一个 profile</p>'))
            return
          }
          const profile = st.profile
          const data = await doAction({ kind: 'deploy', name, profile })
          if (data) {
            showModal(modalHtml('部署成功', `<p>已把 <b>${esc(name)}</b> 部署到 profile <b>${esc(profile)}</b>。</p><p class="mcp-dim">${esc(data.output || '')}</p>`))
          }
        }

        async function removeServer(name, profile, st) {
          const data = await doAction({ kind: 'remove', name, profile })
          if (data) render(st)
        }

        // ---- 自定义部署 ----
        function openDeployCustom(st) {
          if (st.profile === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">请先到「已部署」tab 新建一个 profile</p>'))
            return
          }
          const body =
            `<label class="mcp-field"><span>类型</span>` +
            `<select id="mcp-dc-type" class="mcp-input mcp-select">` +
            `<option value="remote">远端 MCP（填 URL 地址）</option>` +
            `<option value="image">镜像 MCP（填镜像名）</option>` +
            `</select></label>` +
            `<label class="mcp-field"><span>名称</span>` +
            `<input id="mcp-dc-name" class="mcp-input" placeholder="例如 my-mcp"></label>` +
            `<div id="mcp-dc-remote-fields">` +
            `<label class="mcp-field"><span>URL</span>` +
            `<input id="mcp-dc-url" class="mcp-input" placeholder="http://host:port/mcp 或 https://…"></label>` +
            `<label class="mcp-field"><span>传输方式</span>` +
            `<select id="mcp-dc-transport" class="mcp-input mcp-select">` +
            `<option value="streamable-http">streamable-http</option>` +
            `<option value="sse">sse</option>` +
            `</select></label>` +
            `</div>` +
            `<div id="mcp-dc-image-fields" style="display:none">` +
            `<label class="mcp-field"><span>镜像地址</span>` +
            `<input id="mcp-dc-image" class="mcp-input" placeholder="例如 mcp/sqlite:latest"></label>` +
            `<label class="mcp-field"><span>启动命令参数（可选，空格分隔）</span>` +
            `<input id="mcp-dc-command" class="mcp-input" placeholder="例如 --db-path /mcp/db.sqlite"></label>` +
            `<label class="mcp-field"><span>数据卷（可选，空格分隔）</span>` +
            `<input id="mcp-dc-volumes" class="mcp-input" placeholder="例如 mcp-data:/mcp"></label>` +
            `<label class="mcp-field-inline"><input id="mcp-dc-pull" type="checkbox" checked> <span>部署前自动拉取镜像</span></label>` +
            `</div>` +
            `<label class="mcp-field"><span>描述（可选）</span>` +
            `<input id="mcp-dc-desc" class="mcp-input" placeholder="显示在看板上的说明"></label>` +
            `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="deploy-custom-submit">部署</button></div>`
          showModal(modalHtml(`自定义部署 → ${esc(st.profile)}`, body))
          const sel = document.getElementById('mcp-dc-type')
          if (sel) {
            sel.addEventListener('change', () => {
              const isImage = sel.value === 'image'
              const rf = document.getElementById('mcp-dc-remote-fields')
              const im = document.getElementById('mcp-dc-image-fields')
              if (rf) rf.style.display = isImage ? 'none' : ''
              if (im) im.style.display = isImage ? '' : 'none'
            })
          }
        }

        async function submitDeployCustom(st) {
          const type = document.getElementById('mcp-dc-type')?.value || 'remote'
          const name = document.getElementById('mcp-dc-name')?.value?.trim() ?? ''
          const url = document.getElementById('mcp-dc-url')?.value?.trim() ?? ''
          const transport = document.getElementById('mcp-dc-transport')?.value || 'streamable-http'
          const image = document.getElementById('mcp-dc-image')?.value?.trim() ?? ''
          const commandStr = document.getElementById('mcp-dc-command')?.value?.trim() ?? ''
          const volumesStr = document.getElementById('mcp-dc-volumes')?.value?.trim() ?? ''
          const pull = Boolean(document.getElementById('mcp-dc-pull')?.checked)
          const desc = document.getElementById('mcp-dc-desc')?.value?.trim() ?? ''

          if (st.profile === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">请先选择/新建 profile</p>'))
            return
          }
          if (name === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">名称不能为空</p>'))
            return
          }
          const action = { kind: 'deploy-custom', profile: st.profile, type, name, description: desc, pull }
          if (type === 'remote') {
            if (url === '') {
              showModal(modalHtml('提示', '<p class="mcp-err">URL 不能为空</p>'))
              return
            }
            // gateway 安全策略硬性要求 remote URL 必须 https（http 会被拒绝加载）
            if (!/^https:\/\/\S+$/i.test(url)) {
              showModal(modalHtml('提示', '<p class="mcp-err">远端 MCP URL 必须为 https:// 开头（gateway 安全策略拒绝 http）。</p>'))
              return
            }
            action.url = url
            action.transport = transport
          } else {
            if (image === '') {
              showModal(modalHtml('提示', '<p class="mcp-err">镜像地址不能为空</p>'))
              return
            }
            action.image = image
            if (commandStr !== '') action.command = commandStr.split(/\s+/)
            if (volumesStr !== '') action.volumes = volumesStr.split(/\s+/)
          }
          const data = await doAction(action)
          if (data) {
            closeTopModal()
            showModal(modalHtml('部署完成', `<p>已把 <b>${esc(name)}</b> 写入 profile <b>${esc(st.profile)}</b>。</p>` +
              `<p class="mcp-dim">${esc(data.output || '')}</p>` +
              `<p class="mcp-warn">⚠ 新 server 需重启 Gateway 后生效。重启会短暂断开当前 MCP 连接（客户端会自动重连）。</p>` +
              `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="gateway-restart">立即重启 Gateway</button></div>`))
          }
        }

        function confirmGatewayRestart(st) {
          const gw = st.snapshot?.gateway || {}
          const port = gw.port || 8000
          const profile = gw.profile || st.profile || 'taskagent'
          const body =
            `<p>将重启 Gateway（profile <b>${esc(profile)}</b>，端口 <b>${port}</b>），` +
            `并带上 <code>--verify-signatures=false</code>（解决镜像签名校验访问 Docker Hub CDN 被墙的问题）。</p>` +
            `<p class="mcp-warn">⚠ 重启会短暂断开当前 MCP 连接（客户端自动重连）。确定继续？</p>` +
            `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="gateway-restart-confirm">确认重启</button></div>`
          showModal(modalHtml('重启 Gateway', body))
        }

        async function doGatewayRestart(st) {
          const gw = st.snapshot?.gateway || {}
          const action = { kind: 'gateway-restart' }
          if (gw.profile) action.profile = gw.profile
          if (gw.port) action.port = gw.port
          const data = await doAction(action)
          if (data) {
            closeTopModal()
            showModal(modalHtml('重启已触发', `<p>Gateway 正在重启（profile <b>${esc(action.profile || 'taskagent')}</b>，端口 <b>${esc(String(action.port || 8000))}</b>）。</p>` +
              `<p class="mcp-dim">约 10 秒后重新连接；工具列表将包含新部署的 server。</p>`))
          }
        }

        function openNewProfile(st) {
          const body =
            `<label class="mcp-field"><span>profile 名称</span>` +
            `<input id="mcp-np-name" class="mcp-input" placeholder="例如 default / prod"></label>` +
            `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="new-profile-submit">创建</button></div>`
          showModal(modalHtml('新建 profile', body))
        }

        async function submitNewProfile(st) {
          const name = document.getElementById('mcp-np-name')?.value?.trim() ?? ''
          if (name === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">profile 名不能为空</p>'))
            return
          }
          const data = await doAction({ kind: 'create-profile', name })
          if (data) {
            closeTopModal()
            st.profile = data.profileId || name
            render(st)
          }
        }

        function openSettings(st) {
          const cfg = st.snapshot?.config || {}
          const ssh = cfg.ssh || {}
          const auth = ssh.auth || 'password'
          const body =
            `<label class="mcp-field"><span>SSH host</span>` +
            `<input id="mcp-s-host" class="mcp-input" value="${esc(ssh.host || '')}" placeholder="例如 192.168.1.100"></label>` +
            `<label class="mcp-field"><span>SSH port</span>` +
            `<input id="mcp-s-port" class="mcp-input" type="number" value="${num(ssh.port) || 22}"></label>` +
            `<label class="mcp-field"><span>SSH user</span>` +
            `<input id="mcp-s-user" class="mcp-input" value="${esc(ssh.user || '')}" placeholder="例如 root"></label>` +
            `<label class="mcp-field"><span>认证方式</span>` +
            `<select id="mcp-s-auth" class="mcp-input mcp-select">` +
            `<option value="password" ${auth === 'password' ? 'selected' : ''}>密码</option>` +
            `<option value="key" ${auth === 'key' ? 'selected' : ''}>SSH 密钥</option>` +
            `</select></label>` +
            `<div id="mcp-s-pwd-field">` +
            `<label class="mcp-field"><span>SSH password</span>` +
            `<input id="mcp-s-pwd" class="mcp-input" type="password" placeholder="当前${ssh.passwordSet ? '已设置' : '未设置'}（留空保持不变）"></label>` +
            `</div>` +
            `<div id="mcp-s-key-field" style="display:${auth === 'key' ? '' : 'none'}">` +
            `<label class="mcp-field"><span>私钥路径</span>` +
            `<input id="mcp-s-key" class="mcp-input" value="${esc(ssh.keyPath || '')}" placeholder="C:\\Users\\...\\.ssh\\id_ed25519"></label>` +
            `<label class="mcp-field"><span>密钥口令（可选）</span>` +
            `<input id="mcp-s-keypass" class="mcp-input" type="password" placeholder="当前${ssh.passphraseSet ? '已设置' : '未设置'}"></label>` +
            `</div>` +
            `<label class="mcp-field"><span>轮询间隔（毫秒）</span>` +
            `<input id="mcp-s-poll" class="mcp-input" type="number" value="${num(cfg.pollIntervalMs) || 8000}"></label>` +
            `<p class="mcp-dim">凭据以 Windows DPAPI 加密存储在本机（仅当前用户可解密），不会明文落盘。</p>` +
            `<div class="mcp-modal-actions"><button class="mcp-btn mcp-primary" data-act="settings-submit">保存并重连</button></div>`
          showModal(modalHtml('连接设置', body))
          const sel = document.getElementById('mcp-s-auth')
          if (sel) {
            sel.addEventListener('change', () => {
              const isKey = sel.value === 'key'
              const pf = document.getElementById('mcp-s-pwd-field')
              const kf = document.getElementById('mcp-s-key-field')
              if (pf) pf.style.display = isKey ? 'none' : ''
              if (kf) kf.style.display = isKey ? '' : 'none'
            })
          }
        }

        async function submitSettings(st) {
          const host = document.getElementById('mcp-s-host')?.value?.trim() ?? ''
          const port = Number(document.getElementById('mcp-s-port')?.value) || 22
          const user = document.getElementById('mcp-s-user')?.value?.trim() ?? ''
          const auth = document.getElementById('mcp-s-auth')?.value || 'password'
          const pwd = document.getElementById('mcp-s-pwd')?.value ?? ''
          const keyPath = document.getElementById('mcp-s-key')?.value?.trim() ?? ''
          const keyPass = document.getElementById('mcp-s-keypass')?.value ?? ''
          const pollIntervalMs = Number(document.getElementById('mcp-s-poll')?.value) || 8000
          if (host === '' || user === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">host 和 user 不能为空</p>'))
            return
          }
          if (auth === 'key' && keyPath === '') {
            showModal(modalHtml('提示', '<p class="mcp-err">密钥认证需填写私钥路径</p>'))
            return
          }
          const action = { kind: 'set-config', pollIntervalMs, ssh: { host, port, user, auth } }
          if (pwd !== '') action.ssh.password = pwd
          if (keyPath !== '') action.ssh.keyPath = keyPath
          if (keyPass !== '') action.ssh.passphrase = keyPass
          const data = await doAction(action)
          if (data) {
            closeTopModal()
            startPoll()
          }
        }

        // ---- 模态框 ----
        function modalHtml(title, body, wide) {
          return (
            `<div class="mcp-modal-backdrop">` +
            `<div class="mcp-modal${wide ? ' mcp-modal-wide' : ''}">` +
            `<div class="mcp-modal-head"><span>${esc(title)}</span><button class="mcp-modal-x" data-act="modal-close">×</button></div>` +
            `<div class="mcp-modal-body">${body}</div>` +
            `</div></div>`
          )
        }

        function showModal(html) {
          closeTopModal()
          const host = document.createElement('div')
          host.className = 'mcp-modal-host'
          host.innerHTML = html
          document.body.appendChild(host)
          host.querySelectorAll('[data-act]').forEach((el) => {
            el.addEventListener('click', () => {
              const act = el.getAttribute('data-act')
              if (act === 'modal-close') closeTopModal()
              else handleAct(act, el, state, null)
            })
          })
        }

        function closeTopModal() {
          const host = document.querySelector('.mcp-modal-host')
          if (host) host.remove()
        }

        render(state)
      })
    }

    // ---- 样式 ----
    function injectStyle() {
      const style = document.createElement('style')
      style.textContent = `
        [data-dsh-mcp-gateway-board-entry] {
          display: flex; align-items: center; gap: 8px; width: 100%;
          padding: 8px 12px; margin: 2px 0; border: none; background: transparent;
          color: inherit; font-size: 13px; cursor: pointer; border-radius: 6px;
          text-align: left;
        }
        [data-dsh-mcp-gateway-board-entry]:hover { background: rgba(128,128,128,0.15); }
        [data-dsh-mcp-gateway-board-entry] svg { flex: 0 0 auto; opacity: 0.85; }

        /* 看板激活时隐藏中心列除看板外的其它子元素（会话内容保持挂载） */
        html[data-dsh-mcp-gateway-board-active] [class*="centerCol"] > *:not([data-dsh-mcp-gateway-board-view]),
        html[data-dsh-mcp-gateway-board-active] [data-pane="conversation"] > *:not([data-dsh-mcp-gateway-board-view]) {
          display: none;
        }

        [data-dsh-mcp-gateway-board-view] {
          position: absolute; inset: 0; overflow: auto; z-index: 30;
          background: var(--bg, #0d1117); color: var(--text, #e6edf3);
          font-family: inherit; font-size: 13px; line-height: 1.5;
          display: flex; flex-direction: column;
        }
        html:not([data-dsh-mcp-gateway-board-active]) [data-dsh-mcp-gateway-board-view] { display: none; }

        .mcp-header{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border,#2a2e37)}
        .mcp-title{font-weight:600;font-size:15px}
        .mcp-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary,#9aa4b2);flex:1}
        .mcp-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
        .mcp-ok{background:#3fb950}
        .mcp-err{background:#f85149}
        .mcp-warn{background:#d29922}
        .mcp-header-actions{display:flex;gap:6px}
        .mcp-tabs{display:flex;gap:4px;padding:8px 14px 0}
        .mcp-tab{padding:6px 14px;border:1px solid var(--border,#2a2e37);background:transparent;color:var(--text,#e6edf3);border-radius:6px 6px 0 0;cursor:pointer;font-size:13px}
        .mcp-tab-active{background:var(--bg-secondary,#1c2128);border-bottom-color:transparent;font-weight:600}
        .mcp-subtabs{display:flex;gap:2px;padding:4px 14px 0}
        .mcp-subtab{padding:4px 12px;border:none;background:transparent;color:var(--text-secondary,#9aa4b2);cursor:pointer;font-size:12px;border-bottom:2px solid transparent}
        .mcp-subtab:hover{color:var(--text,#e6edf3)}
        .mcp-subtab-active{color:var(--text,#e6edf3);border-bottom-color:var(--accent,#58a6ff);font-weight:600}
        .mcp-bar{display:flex;align-items:flex-end;gap:8px;padding:12px 14px;flex-wrap:wrap}
        .mcp-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;font-size:13px}
        .mcp-field-inline{display:flex;align-items:center;gap:6px;font-size:13px}
        .mcp-field-inline span{color:var(--text-secondary,#9aa4b2)}
        .mcp-grow{flex:1}
        .mcp-input{background:var(--bg,#11151b);border:1px solid var(--border,#2a2e37);color:var(--text,#e6edf3);border-radius:6px;padding:6px 10px;font-size:13px;outline:none}
        .mcp-select{color-scheme:dark}
        .mcp-input:focus{border-color:#58a6ff}
        .mcp-select{min-width:140px}
        .mcp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;padding:10px 14px}
        .mcp-table-wrap{padding:10px 14px;overflow:auto}
        .mcp-table{width:100%;border-collapse:collapse;font-size:12px}
        .mcp-table th,.mcp-table td{padding:6px 8px;border-bottom:1px solid var(--border,#2a2e37);text-align:left;vertical-align:middle}
        .mcp-table th{color:var(--text-secondary,#9aa4b2);font-weight:600;position:sticky;top:0;background:var(--bg-secondary,#1c2128)}
        .mcp-td-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
        .mcp-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--text-secondary,#9aa4b2)}
        .mcp-cell-actions{white-space:nowrap}
        .mcp-mini{padding:2px 8px;font-size:11px;margin-right:2px}
        .mcp-log{max-height:420px;overflow:auto;background:var(--bg,#0d1117);border:1px solid var(--border,#2a2e37);border-radius:6px;padding:8px}
        .mcp-log pre{margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all}
        .mcp-term-wrap{border:1px solid var(--border,#2a2e37);border-radius:6px;overflow:hidden}
        .mcp-term{height:calc(86vh - 220px);min-height:280px;max-height:70vh;overflow:auto;background:#0d1117;color:#e6edf3;margin:0;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-all;outline:none;cursor:text;box-sizing:border-box}
        .mcp-term:focus{box-shadow:0 0 0 1px var(--accent,#58a6ff) inset}
        .mcp-text-danger{color:#f85149}
        .mcp-card{background:var(--bg,#11151b);border:1px solid var(--border,#2a2e37);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}
        .mcp-card-head{display:flex;align-items:center;gap:8px;justify-content:space-between}
        .mcp-card-name{font-weight:600;font-size:14px}
        .mcp-card-desc{font-size:12px;color:var(--text-secondary,#9aa4b2);line-height:1.5;min-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
        .mcp-card-endpoint{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text-secondary,#9aa4b2);line-height:1.5;word-break:break-all;opacity:.85}
        .mcp-card-meta{display:flex;gap:8px;flex-wrap:wrap}
        .mcp-meta{font-size:11px;color:var(--text-secondary,#9aa4b2);background:var(--bg-secondary,#1c2128);padding:2px 8px;border-radius:10px}
        .mcp-badge{font-size:11px;color:#58a6ff;border:1px solid #58a6ff55;padding:1px 7px;border-radius:10px}
        .mcp-card-actions{display:flex;gap:6px;margin-top:auto;justify-content:flex-end}
        .mcp-btn{padding:5px 12px;border:1px solid var(--border,#2a2e37);background:transparent;color:var(--text,#e6edf3);border-radius:6px;cursor:pointer;font-size:12px}
        .mcp-btn:hover{border-color:#58a6ff}
        .mcp-primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
        .mcp-primary:hover{background:#388bfd}
        .mcp-danger{color:#f85149;border-color:#f85149}
        .mcp-danger:hover{background:#f8514922}
        .mcp-danger-ghost{color:#f85149}
        .mcp-empty{padding:30px 14px;text-align:center;color:var(--text-secondary,#9aa4b2);font-size:13px}
        .mcp-hint{padding:4px 14px 14px;text-align:center;color:var(--text-secondary,#9aa4b2);font-size:12px}
        .mcp-dim{color:var(--text-secondary,#9aa4b2);font-size:12px}
        .mcp-footer{padding:10px 14px;border-top:1px solid var(--border,#2a2e37);font-size:11px;color:var(--text-secondary,#9aa4b2);text-align:right}
        .mcp-modal-host{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center}
        .mcp-modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5)}
        .mcp-modal{position:relative;background:var(--bg,#11151b);border:1px solid var(--border,#2a2e37);border-radius:10px;width:420px;max-width:92vw;max-height:86vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.5)}
        .mcp-modal-wide{width:92vw;max-width:1200px}
        .mcp-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border,#2a2e37);font-weight:600}
        .mcp-modal-x{background:transparent;border:none;color:var(--text-secondary,#9aa4b2);font-size:20px;cursor:pointer;line-height:1}
        .mcp-modal-body{padding:16px;font-size:13px;line-height:1.6}
        .mcp-modal-body p.mcp-warn,.mcp-modal-body p.mcp-err{display:block;padding:8px 10px;border-radius:6px;color:var(--bg,#11151b);font-weight:500}
        .mcp-modal-body p.mcp-warn{background:#d29922}
        .mcp-modal-body p.mcp-err{background:#f85149}
        .mcp-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      `
      document.head.appendChild(style)
      return () => {
        try { style.remove() } catch { /* ignore */ }
      }
    }

    // ---- 侧边栏入口 ----
    function mountEntry(onToggle) {
      const row = document.createElement('button')
      row.setAttribute(ENTRY_ATTR, '')
      row.type = 'button'
      row.innerHTML =
        '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
        '<path d="M1.5 7.5h10.5M3 6.5v.5M5 6.5v.5M7 6.5v.5M9.5 6.5v.5M4 9.5h1M7 9.5h1M10 9.5h1"></path>' +
        '<path d="M12 6.5c1.5.5 2.5 2 2.5 3.5 0 1.5-1.5 2.5-4 2.5H3C1.5 12.5 1 10.5 2 8.5c.3-.7 1-1.2 1.8-1.3"></path>' +
        '</svg>' +
        '<span>Docker</span>'
      row.setAttribute('aria-label', 'Docker 管理')
      row.setAttribute('title', '打开 Docker 管理面板')
      row.addEventListener('click', onToggle)

      const place = () => {
        const sidebar = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
        if (sidebar === null) return
        if (sidebar.contains(row)) return
        const newSession = sidebar.querySelector('button[class*="newSession"]')
        if (newSession !== null && newSession.parentElement !== null) {
          newSession.parentElement.insertBefore(row, newSession.nextSibling)
        } else {
          sidebar.insertBefore(row, sidebar.firstChild)
        }
      }

      place()
      const observer = new MutationObserver(place)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        row.remove()
      }
    }

    // ---- 看板容器（自愈注入到中心列） ----
    function mountBoard() {
      const container = document.createElement('div')
      container.setAttribute(VIEW_ATTR, '')
      const column = document.querySelector('[data-pane="conversation"], [class*="centerCol"]')
      if (column !== null) column.appendChild(container)

      const ensure = () => {
        if (container.parentElement !== null) return
        const col = document.querySelector('[data-pane="conversation"], [class*="centerCol"]')
        if (col !== null) col.appendChild(container)
      }
      const observer = new MutationObserver(ensure)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        container.remove()
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
});
