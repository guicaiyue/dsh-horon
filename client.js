// Horon memory console as a DeepSeek Harness plugin — Client half.
//
// Two surfaces, both registered from here:
//   - the panel: one entry in the root-scoped `sidebar.panellist` list (the global
//     panel icons in the upper left column) plus the matching root-scoped `main`
//     keyed panel. Selecting the row renders the Horon console in an iframe and
//     nothing is added to the Harness page's own document tree;
//   - the settings section (`settings.section`, id `horon`): where the service runs
//     (local python / docker on this host / remote URL), the host directories the
//     docker mounts are bound to, the copyable deploy commands and Dockerfile, and
//     the one-click deploy that runs them here.
//
// The Host half proxies the console under `/dsh-horon/` on the dsh web server
// (behind dsh's own login), so the iframe is same-origin with this page and works
// wherever dsh is opened. Its `/dsh-horon/_dsh/*` endpoints back the settings form.

window.__ModuleLoader__.load({
  id: 'dsh-horon',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-horon'
    const PANEL_ID = 'dsh-horon'
    // The Host half's console route (ROUTE in index.js); the trailing slash matters,
    // the console loads its assets and API relative to it.
    const CONSOLE_URL = '/dsh-horon/'
    const PROBE_URL = `${CONSOLE_URL}api/sessions`
    // The Host half's settings endpoints (API_PREFIX in index.js).
    const API_BASE = '/dsh-horon/_dsh'

    const zh = {
      nav: 'Horon 记忆',
      title: 'Horon 记忆控制台',
      starting: '正在启动 Horon 服务…',
      waiting: 'Horon 服务还没有响应，确认 dsh-horon 插件已启用、服务正在运行',
      retry: '重试',
      open: '在新标签页打开',

      // settings
      sectionTitle: 'Horon 服务',
      loading: '正在读取配置…',
      mode: '运行方式',
      modeArtifact: '正常启动（不用 Docker）',
      modeDocker: 'Docker 启动',
      modeHintArtifact: '下载官方发布并打包好的 Horon，解包到数据目录里直接运行：不需要 Horon 仓库，也不需要 git / npm / Docker，只要本机有 Python 3.12。',
      modeHintDocker: '拉取官方镜像并作为本机容器运行，数据挂载到同一个数据目录；需要本机装了 Docker。',
      artifactReadyHint: '已就绪：版本 {commit} · {platform}，位于数据目录的 runtime 下。',
      artifactMissingHint: '还没下载：点右下角「下载并安装」，会下载、校验、装好依赖。',
      provision: '下载并安装',
      provisioning: '下载安装中…',
      provisionDone: '构建物已就绪，服务正在启动。',
      provisionFailed: '下载或安装失败，原因见日志。',
      autostart: '启动 dsh 时自动拉起',
      autostartHint: 'Docker 模式下只会 docker start 已存在的容器，不会替你创建。',

      paths: '数据与下载',
      pathsHint: '所有数据（数据库、.env、下载的运行时、tag 插件）都在这一个目录下，两种运行方式共用，不会因为换方式丢记忆。留空用默认值，可以写 ~。',
      dataDir: '数据目录',
      dataDirHint: '默认：{def}',
      proxy: '下载代理',
      proxyHint: '默认 https://gh-proxy.com，用于从 GitHub Release 下载构建物；Docker 模式下拉镜像也会写进 ~/.docker/config.json。留空表示直连。',

      applied: '实际生效',

      save: '保存',
      saving: '保存中…',
      reset: '还原',
      saveNote: '保存会改写 profile 的 cordis.patch.yml 并立即重载插件：服务会按新的方式和目录重启。',
      saved: '已保存，插件正在重载。',
      editBlocked: '这个 dsh 没有提供配置编辑器，只能手工改 profile 的 cordis.patch.yml。',

      deploy: '一键部署',
      deploying: '部署中…',
      deployNote: '在本机 docker pull 官方镜像再 docker run。镜像由 CI 按锁定 commit 构建，本机不构建。',
      deployLog: '部署日志',
      deployDone: '部署完成，服务已就绪。',
      deployFailed: '部署失败，原因见上面的日志。',
      copy: '复制',
      copied: '已复制',
      copyFailed: '浏览器不允许自动复制，请在下面手动选中。',
      tabCommands: '命令',
      tabCompose: 'compose',
      tabEnv: '.env 示例',

      onboardingTitle: '先选一种运行方式',
      onboardingNote: 'Horon 服务需要一个运行时。选一种装好就能用；之后可在「设置 → Horon 服务」里随时改。',
      onboardingArtifact: '正常启动（要 Python 3.12，不要 Docker）',
      onboardingDocker: 'Docker 启动（要本机装了 Docker）',
      onboardingLater: '稍后再说',
      onboardingSize: '正常启动约 40 MB；Docker 镜像约 250 MB。两种方式共用一个数据目录，随时可以换。',
      onboardingWorking: '正在安装，进度见「设置 → Horon 服务」的日志。',

      statusServing: '服务可访问',
      statusDown: '服务不可访问',
      dockerMissing: 'Docker 不可用',
      dockerVersion: 'Docker',
      noContainer: '还没有容器',
      containerState: '容器状态',
      guardChain: '拦截链',
      guardOn: '已挂载',
      guardOff: '已关闭（hooks: false）',
      guardDenied: '本次共拒绝',
      guardFailed: '网关失败',
      guardHint: '拦截链只负责问 Horon；真正拦不拦，取决于库里的 guard 电路与 tool_guards 规则。新装的库是空的，所以「拒绝 0 次」通常表示没有规则，而不是规则放行。',
      guardFailedHint: '网关失败：这次插件挂载以来，有多少次请求没送到 Horon（连不上、超时或返回错误）。这些调用因为 fail-open 没有被检查，最常见的原因是 Horon 服务正在重启。',
      guardLastError: '最近一次',
    }

    const en = {
      nav: 'Horon Memory',
      title: 'Horon Memory Console',
      starting: 'Starting the Horon service…',
      waiting: 'The Horon service has not answered yet; check that the dsh-horon plugin is enabled and the service is running',
      retry: 'Retry',
      open: 'Open in a new tab',

      sectionTitle: 'Horon service',
      loading: 'Loading the settings…',
      mode: 'Mode',
      modeArtifact: 'Normal start (no Docker)',
      modeDocker: 'Docker start',
      modeHintArtifact: 'Downloads the artifact CI released from GitHub, unpacks it under the data directory and runs it: no Horon repository, no git, no npm, no Docker.',
      modeHintDocker: 'Pulls the image CI released and runs it as a local container, with the same data directory mounted in.',
      artifactReadyHint: 'Ready: version {commit} · {platform}, under the data directory runtime folder.',
      artifactMissingHint: 'Not downloaded yet: press Download and install; it fetches, verifies and installs the runtime.',
      provision: 'Download and install',
      provisioning: 'Downloading…',
      provisionDone: 'The artifact is ready; the service is starting.',
      provisionFailed: 'The download or install failed; see the log.',
      autostart: 'Start it when dsh starts',
      autostartHint: 'In Docker mode this only runs docker start on an existing container; it never creates one.',

      paths: 'Data and downloads',
      pathsHint: 'Everything lives under this one directory — database, .env, the downloaded runtime, tag plugins — and both runtimes share it, so switching keeps your memory. Empty uses the default; ~ works.',
      dataDir: 'Data directory',
      dataDirHint: 'Default: {def}',
      proxy: 'Download proxy',
      proxyHint: 'https://gh-proxy.com by default, used to fetch the artifact from GitHub Releases; in Docker mode it is also written into ~/.docker/config.json for pulls. Empty means a direct connection.',

      applied: 'In effect',

      save: 'Save',
      saving: 'Saving…',
      reset: 'Revert',
      saveNote: 'Saving rewrites the profile cordis.patch.yml and reloads the plugin right away: the service restarts with the new runtime and directory.',
      saved: 'Saved; the plugin is reloading.',
      editBlocked: 'This dsh exposes no configuration editor; edit the profile cordis.patch.yml by hand.',

      deploy: 'Deploy now',
      deploying: 'Deploying…',
      deployNote: 'Pulls the official image and runs the container here. CI builds it from the pinned commit; nothing is built locally.',
      deployLog: 'Deploy log',
      deployDone: 'Deployed; the service is up.',
      deployFailed: 'The deploy failed; see the log above.',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'The browser refused clipboard access; select the text below instead.',
      tabCommands: 'Commands',
      tabCompose: 'compose',
      tabEnv: '.env example',

      onboardingTitle: 'Choose how to run it',
      onboardingNote: 'The Horon service needs a runtime. Pick one and it is ready; you can change it later under Settings → Horon service.',
      onboardingArtifact: 'Normal start (Python 3.12, no Docker)',
      onboardingDocker: 'Docker start (needs Docker here)',
      onboardingLater: 'Not now',
      onboardingSize: 'Normal start is about 40 MB, the Docker image about 250 MB. Both share one data directory, so switching keeps your memory.',
      onboardingWorking: 'Installing; the log is under Settings → Horon service.',

      statusServing: 'Service reachable',
      statusDown: 'Service unreachable',
      dockerMissing: 'Docker is not available',
      dockerVersion: 'Docker',
      noContainer: 'no container yet',
      containerState: 'Container',
      guardChain: 'Guard chain',
      guardOn: 'mounted',
      guardOff: 'off (hooks: false)',
      guardDenied: 'denied',
      guardFailed: 'gateway failures',
      guardHint: 'The chain only asks Horon; whether a call is blocked depends on the guard circuits and tool_guards rules in the database. A fresh database has none, so "denied 0" usually means no rules, not rules that passed.',
      guardFailedHint: 'Gateway failures: requests that never reached Horon since this plugin mounted (connection refused, timeout, or an error response). Those calls go unchecked because the chain is fail-open; a service restart is the usual cause.',
      guardLastError: 'last',
    }

    /** Calls the Host half and returns the parsed payload. */
    async function api(path, options = {}) {
      const response = await fetch(`${API_BASE}${path}`, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        payload = { error: text.slice(0, 300) }
      }
      if (!response.ok) {
        const error = new Error(payload.error ?? `HTTP ${String(response.status)}`)
        error.status = response.status
        throw error
      }
      return payload
    }

    // Horon's own wordmark (the H outline is Instrument Serif, SIL OFL 1.1).
    function Mark({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { width: 32, height: 32, rx: 8, fill: '#3A2A34' }),
        h('path', {
          transform: 'translate(5.42 26) scale(0.2778)',
          fill: '#FFF3E6',
          stroke: '#FFF3E6',
          strokeWidth: 2.4,
          strokeLinejoin: 'round',
          d: 'M21.70 0L3.40 0Q1.90 0 1.90-1.10Q1.90-2 3.20-2.30L5.50-2.70Q7.60-3.10 8.25-3.80Q8.90-4.50 8.90-6.60L8.90-65.40Q8.90-67.50 8.25-68.20Q7.60-68.90 5.50-69.30L3.20-69.70Q1.90-70 1.90-70.90Q1.90-72 3.40-72L21.70-72Q23.20-72 23.20-70.80Q23.20-69.90 22.10-69.70L19.40-69.30Q17.30-69 16.65-68.20Q16-67.40 16-65.30L16-40.20Q16-38.80 17.40-38.80L37.20-38.80Q38.60-38.80 38.60-40.20L38.60-65.30Q38.60-67.40 37.95-68.20Q37.30-69 35.20-69.30L32.50-69.70Q31.40-69.90 31.40-70.80Q31.40-72 32.90-72L51.20-72Q52.70-72 52.70-70.90Q52.70-70 51.40-69.70L49.10-69.30Q47-68.90 46.35-68.20Q45.70-67.50 45.70-65.40L45.70-6.60Q45.70-4.50 46.35-3.80Q47-3.10 49.10-2.70L51.40-2.30Q52.70-2 52.70-1.10Q52.70 0 51.20 0L32.90 0Q31.40 0 31.40-1.20Q31.40-2.10 32.50-2.30L35.20-2.70Q37.30-3 37.95-3.80Q38.60-4.60 38.60-6.70L38.60-34.40Q38.60-35.80 37.20-35.80L17.40-35.80Q16-35.80 16-34.40L16-6.70Q16-4.60 16.65-3.80Q17.30-3 19.40-2.70L22.10-2.30Q23.20-2.10 23.20-1.20Q23.20 0 21.70 0Z',
        }),
        h('circle', { cx: 23.9, cy: 23.8, r: 2.3, fill: '#F0705A' }),
      )
    }

    function Console(props) {
      const t = props.t ?? ((key) => key)
      const [ready, setReady] = React.useState(false)
      const [attempt, setAttempt] = React.useState(0)
      // First run: nobody has chosen a runtime yet, so the panel asks before showing a spinner.
      const [onboarding, setOnboarding] = React.useState(undefined)
      const [choice, setChoice] = React.useState(undefined)
      const [choiceNote, setChoiceNote] = React.useState(undefined)

      React.useEffect(() => {
        let cancelled = false
        api('/config')
          .then((payload) => {
            if (!cancelled) setOnboarding(payload.onboarding === true)
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [])

      // Poll a job until it stops; the log itself is shown in Settings.
      const waitJob = async (path) => {
        for (let i = 0; i < 1800; i += 1) {
          const state = await api(path)
          if (state.running !== true) return state
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        return undefined
      }

      const choose = async (kind) => {
        setChoice(kind)
        setChoiceNote(undefined)
        try {
          if (kind === 'artifact') {
            await api('/provision', { method: 'POST', body: { config: { mode: 'artifact' } } })
            await waitJob('/provision-log')
          } else {
            await api('/deploy', { method: 'POST', body: { config: { mode: 'docker' } } })
            await waitJob('/logs')
          }
          // Saving the mode remounts the plugin, which starts the service the chosen way.
          await api('/config', { method: 'POST', body: { config: { mode: kind } } })
          setOnboarding(false)
          setAttempt((value) => value + 1)
        } catch (caught) {
          setChoiceNote(String(caught?.message ?? caught))
        } finally {
          setChoice(undefined)
        }
      }

      // Probe until the Host half's service answers, then stop polling.
      React.useEffect(() => {
        let cancelled = false
        let timer
        const probe = async () => {
          try {
            const response = await fetch(PROBE_URL, { cache: 'no-store' })
            if (response.ok) {
              if (!cancelled) setReady(true)
              return
            }
          } catch {}
          if (!cancelled) timer = setTimeout(probe, 1000)
        }
        probe()
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [attempt])

      if (!ready && onboarding === true) {
        const card = { background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md, 8px)', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '420px', font: 'var(--dsw-font-xs-13)' }
        const primary = { cursor: choice === undefined ? 'pointer' : 'not-allowed', opacity: choice === undefined ? 1 : 0.6, color: 'var(--dsw-alias-label-primary-foreground)', background: 'var(--dsw-alias-button-primary-fill)', border: '0.5px solid var(--dsw-alias-button-primary-fill)', borderRadius: 'var(--dsw-radius-sm)', font: 'inherit', padding: '7px 14px' }
        const secondary = { cursor: choice === undefined ? 'pointer' : 'not-allowed', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)', font: 'inherit', padding: '7px 14px' }
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '24px', background: 'var(--dsw-alias-bg-base)' } },
          h(
            'div',
            { style: card },
            h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, t('onboardingTitle')),
            h('div', { style: { color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } }, t('onboardingNote')),
            h('button', { type: 'button', style: primary, disabled: choice !== undefined, onClick: () => choose('artifact') }, t('onboardingArtifact')),
            h('button', { type: 'button', style: secondary, disabled: choice !== undefined, onClick: () => choose('docker') }, t('onboardingDocker')),
            h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } }, t('onboardingSize')),
            choice === undefined ? null : h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('onboardingWorking')),
            choiceNote === undefined ? null : h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.6 } }, choiceNote),
            h('button', { type: 'button', style: { ...secondary, alignSelf: 'flex-start', border: 'none', color: 'var(--dsw-alias-label-tertiary)' }, disabled: choice !== undefined, onClick: () => setOnboarding(false) }, t('onboardingLater')),
          ),
        )
      }

      if (!ready) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              padding: '24px',
              textAlign: 'center',
              color: 'var(--dsw-alias-label-tertiary)',
              background: 'var(--dsw-alias-bg-base)',
              font: 'var(--dsw-font-xs-13)',
            },
          },
          h('div', null, t('starting')),
          h('div', { style: { color: 'var(--dsw-alias-label-quaternary)' } }, t('waiting')),
          h(
            'button',
            {
              type: 'button',
              onClick: () => setAttempt((value) => value + 1),
              style: {
                cursor: 'pointer',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-layer-1)',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                borderRadius: 'var(--dsw-radius-sm)',
                font: 'inherit',
                padding: '5px 12px',
              },
            },
            t('retry'),
          ),
        )
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base)' } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              flex: 'none',
              height: '34px',
              padding: '0 10px',
              borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
              color: 'var(--dsw-alias-label-secondary)',
              font: 'var(--dsw-font-xxs-12)',
            },
          },
          h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('title')),
          h(
            'a',
            {
              href: CONSOLE_URL,
              target: '_blank',
              rel: 'noreferrer',
              style: { marginLeft: 'auto', color: 'var(--dsw-alias-state-business-primary)', textDecoration: 'none' },
            },
            t('open'),
          ),
        ),
        h('iframe', {
          src: CONSOLE_URL,
          title: t('title'),
          style: { flex: 'auto', width: '100%', minHeight: 0, border: 0, display: 'block', background: 'var(--dsw-alias-bg-base)' },
        }),
      )
    }

    // ---- settings section ---------------------------------------------------------------------

    const CSS = `
.dshhw-settings{display:flex;flex-direction:column;gap:12px;max-width:760px;}
.dshhw-settings h3{margin:0;font-size:14px;}
.dshhw-section{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;display:flex;flex-direction:column;gap:10px;}
.dshhw-section>h4{margin:0;font-size:13px;}
.dshhw-row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;}
.dshhw-field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.dshhw-field>label{font-size:12px;color:var(--dsw-alias-label-secondary);}
.dshhw-input,.dshhw-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 9px;font-size:13px;font-family:inherit;min-width:0;}
.dshhw-input:focus,.dshhw-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}
.dshhw-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.45;word-break:break-all;}
.dshhw-note{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;}
.dshhw-error{font-size:12px;color:var(--dsw-alias-state-error-primary);line-height:1.5;white-space:pre-wrap;}
/* state 色在浅色主题里当正文太浅（amber-500 / green-500 落在近白底上只有 2.1:1），
   所以状态只交给圆点，正文用 label-primary，深浅两套主题都读得清。 */
.dshhw-ok,.dshhw-warn{display:flex;gap:6px;align-items:flex-start;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);}
.dshhw-ok::before,.dshhw-warn::before{content:"";flex:none;width:7px;height:7px;margin-top:6px;border-radius:50%;}
.dshhw-ok::before{background:var(--dsw-alias-state-success-primary);}
.dshhw-warn::before{background:var(--dsw-alias-state-warn-primary);}
.dshhw-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 12px;font-size:13px;line-height:20px;cursor:pointer;font-family:inherit;}
.dshhw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.dshhw-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active);}
.dshhw-btn:disabled{opacity:.4;cursor:not-allowed;}
/* 主按钮跟 dsh 自己的按钮同一套 token：填充色在浅色主题里近黑、深色主题里近白，
   所以文字必须用 label-primary-foreground；写死 #fff 在深色主题里就是白底白字。 */
.dshhw-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}
.dshhw-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover);}
.dshhw-btn-primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover);}
.dshhw-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.dshhw-spacer{flex:1;}
.dshhw-tabs{display:flex;gap:4px;flex-wrap:wrap;}
.dshhw-tab{appearance:none;background:none;border:1px solid transparent;border-radius:6px;color:var(--dsw-alias-label-secondary);padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;}
.dshhw-tab[aria-selected="true"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}
.dshhw-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;white-space:pre;overflow:auto;max-height:280px;margin:0;}
.dshhw-log{max-height:180px;white-space:pre-wrap;word-break:break-all;}
.dshhw-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none;}
.dshhw-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dshhw-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;}
.dshhw-clip{position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;}
`

    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
    }

    /** A labelled form control wrapper. */
    function Field({ label, hint, width, children }) {
      return h(
        'div',
        { className: 'dshhw-field', style: width === undefined ? undefined : { width } },
        label === undefined ? null : h('label', null, label),
        children,
        hint === undefined ? null : h('div', { className: 'dshhw-hint' }, hint),
      )
    }

    /** A single-line text control; `placeholder` carries the resolved default. */
    function TextField({ label, value, placeholder, hint, width, onChange }) {
      return h(
        Field,
        { label, hint, width },
        h('input', {
          className: 'dshhw-input',
          value: value ?? '',
          placeholder: placeholder ?? '',
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
        }),
      )
    }

    function SettingsSection(props) {
      const t = props.t ?? ((key) => key)

      const [data, setData] = React.useState(undefined)
      const [draft, setDraft] = React.useState(undefined)
      const [initial, setInitial] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [status, setStatus] = React.useState(undefined)
      const [preview, setPreview] = React.useState(undefined)
      const [tab, setTab] = React.useState('commands')
      const [deploy, setDeploy] = React.useState(undefined)
      const [jobKind, setJobKind] = React.useState('deploy')
      const [copyRequest, setCopyRequest] = React.useState(undefined)
      const [copyNote, setCopyNote] = React.useState(undefined)

      const since = React.useRef(0)
      const clip = React.useRef(null)

      // Load the stored configuration once.
      React.useEffect(() => {
        let cancelled = false
        api('/config')
          .then((payload) => {
            if (cancelled) return
            const config = { ...payload.config, autostart: payload.config.autostart !== false }
            setData(payload)
            setDraft(config)
            setInitial(config)
          })
          .catch((caught) => {
            if (!cancelled) setError(caught.message)
          })
        return () => {
          cancelled = true
        }
      }, [])

      // Docker / container status: a slow poll, it only changes when someone deploys.
      React.useEffect(() => {
        let cancelled = false
        const tick = () => {
          api('/status')
            .then((payload) => {
              if (!cancelled) setStatus(payload)
            })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      // The commands and compose file follow the draft, not the saved config, so a
      // path can be checked before it is written into the profile.
      React.useEffect(() => {
        if (draft === undefined) return undefined
        let cancelled = false
        const timer = setTimeout(() => {
          api('/preview', { method: 'POST', body: { config: draft } })
            .then((payload) => {
              if (!cancelled) setPreview(payload)
            })
            .catch(() => {})
        }, 350)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [draft])

      // Tail the running job's log (deploy for docker mode, provision for artifact mode).
      const running = deploy?.running === true
      const jobPath = jobKind === 'provision' ? '/provision-log' : '/logs'
      React.useEffect(() => {
        if (!running) return undefined
        let cancelled = false
        const timer = setInterval(() => {
          api(`${jobPath}?since=${String(since.current)}`)
            .then((state) => {
              if (cancelled) return
              setDeploy((current) => {
                const appended = current !== undefined && state.from === since.current
                since.current = state.total ?? 0
                return { ...state, text: appended ? `${current.text ?? ''}${state.text ?? ''}` : state.text }
              })
            })
            .catch(() => {})
        }, 1000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [running, jobPath])

      // Clipboard fallback: an http origin is not a secure context, so
      // navigator.clipboard may be missing and the copy has to go through a
      // hidden textarea that lives inside this component.
      const copyId = copyRequest?.id
      React.useEffect(() => {
        if (copyId === undefined) return
        const element = clip.current
        if (element === null) return
        element.focus()
        element.select()
        let done = false
        try {
          done = document.execCommand('copy')
        } catch {
          done = false
        }
        setCopyNote(done ? t('copied') : t('copyFailed'))
      }, [copyId])

      const update = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const copy = async (value) => {
        setCopyNote(undefined)
        try {
          if (navigator.clipboard?.writeText !== undefined) {
            await navigator.clipboard.writeText(value)
            setCopyNote(t('copied'))
            return
          }
        } catch {}
        // Bump the id so selecting the same text twice still triggers the effect.
        setCopyRequest({ text: value, id: (copyRequest?.id ?? 0) + 1 })
      }

      const save = async () => {
        if (draft === undefined) return
        setBusy(true)
        setError(undefined)
        setNotice(undefined)
        try {
          await api('/config', { method: 'POST', body: { config: draft } })
          setInitial(draft)
          setNotice(t('saved'))
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy(false)
        }
      }

      const deployNow = async () => {
        setError(undefined)
        setNotice(undefined)
        try {
          since.current = 0
          setJobKind('deploy')
          const state = await api('/deploy', { method: 'POST', body: { config: draft } })
          since.current = state.total ?? 0
          setDeploy(state)
        } catch (caught) {
          setError(caught.message)
        }
      }

      // artifact mode: download + unpack + bootstrap, then the mount-time spawn picks it up.
      const provisionNow = async () => {
        setError(undefined)
        setNotice(undefined)
        try {
          since.current = 0
          setJobKind('provision')
          const state = await api('/provision', { method: 'POST', body: { config: draft } })
          since.current = state.total ?? 0
          setDeploy(state)
        } catch (caught) {
          setError(caught.message)
        }
      }

      if (draft === undefined) {
        return h(
          'div',
          { className: 'dshhw-settings' },
          h(Styles),
          h('h3', null, t('sectionTitle')),
          h('div', { className: 'dshhw-note' }, error ?? t('loading')),
        )
      }

      const resolved = preview?.resolved ?? data?.resolved ?? {}
      const texts = preview?.texts ?? data?.texts ?? {}
      // Only the two runtimes a user actually picks between; spawn/url stay in the code for
      // development and for an existing remote service, but they are not offered here.
      const mode = draft.mode === 'docker' ? 'docker' : 'artifact'
      const serving = preview?.serving ?? status?.serving
      const docker = status?.docker
      const hooks = status?.hooks

      const blocks = [
        ['commands', t('tabCommands'), texts.commands],
        ['compose', t('tabCompose'), texts.compose],
        ['env', t('tabEnv'), texts.envExample],
      ]
      const active = blocks.find(([key]) => key === tab) ?? blocks[0]

      return h(
        'div',
        { className: 'dshhw-settings' },
        h(Styles),
        h('h3', null, t('sectionTitle')),

        h(
          'div',
          { className: 'dshhw-row' },
          h(
            Field,
            { label: t('mode'), width: '280px' },
            h(
              'select',
              { className: 'dshhw-select', value: mode, onChange: (event) => update({ mode: event.target.value }) },
              h('option', { value: 'artifact' }, t('modeArtifact')),
              h('option', { value: 'docker' }, t('modeDocker')),
            ),
          ),
          h(
            'label',
            { className: 'dshhw-check', title: t('autostartHint') },
            h('input', {
              type: 'checkbox',
              checked: draft.autostart !== false,
              onChange: (event) => update({ autostart: event.target.checked }),
            }),
            t('autostart'),
          ),
        ),
        h('div', { className: 'dshhw-note' }, mode === 'artifact' ? t('modeHintArtifact') : t('modeHintDocker')),
        mode === 'artifact'
          ? h(
              'div',
              { className: 'dshhw-hint' },
              data?.artifactState?.ready === true
                ? t('artifactReadyHint', {
                    commit: (data?.artifact?.commit ?? '').slice(0, 8),
                    platform: data?.artifact?.platform ?? '',
                  })
                : t('artifactMissingHint'),
            )
          : null,

        h(
          'div',
          { className: 'dshhw-row' },
          h(
            'span',
            { className: 'dshhw-status' },
            h('span', {
              className: 'dshhw-dot',
              style: { background: serving ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)' },
            }),
            `${serving ? t('statusServing') : t('statusDown')} · ${status?.base ?? data?.base ?? ''}`,
          ),
          docker === undefined
            ? null
            : docker.available === false
              ? h('span', { className: 'dshhw-warn' }, `${t('dockerMissing')}: ${docker.error ?? ''}`)
              : h(
                  'span',
                  { className: 'dshhw-status' },
                  `${t('dockerVersion')} ${docker.version} · ${
                    docker.container === undefined ? t('noContainer') : `${t('containerState')}: ${docker.container.status}`
                  }`,
                ),
          hooks === undefined
            ? null
            : h(
                'span',
                {
                  className: hooks.degraded || hooks.failed > 0 ? 'dshhw-warn' : 'dshhw-status',
                  title: hooks.failed > 0 ? `${t('guardHint')}
${t('guardFailedHint')}` : t('guardHint'),
                },
                `${t('guardChain')}: ${hooks.enabled ? t('guardOn') : t('guardOff')} · ${t('guardDenied')} ${hooks.denied} · ${t('guardFailed')} ${hooks.failed}`,
                hooks.failed > 0 && hooks.lastError
                  ? ` (${t('guardLastError')}: ${String(hooks.lastError).slice(0, 80)})`
                  : '',
              ),
        ),

        // One directory decides everything else: database, key file, releases, tag plugins.
        h(
          'div',
          { className: 'dshhw-section' },
          h('h4', null, t('paths')),
          h('div', { className: 'dshhw-note' }, t('pathsHint')),
          h(TextField, {
            label: t('dataDir'),
            value: draft.dataDir,
            placeholder: resolved.dataDir ?? data?.defaultDataDir ?? '',
            hint: t('dataDirHint', { def: resolved.dataDir ?? data?.defaultDataDir ?? '' }),
            onChange: (value) => update({ dataDir: value }),
          }),
          h(TextField, {
            label: t('proxy'),
            value: draft.proxy,
            placeholder: data?.defaultProxy ?? '',
            hint: t('proxyHint'),
            onChange: (value) => update({ proxy: value }),
          }),
          h(
            'div',
            { className: 'dshhw-hint' },
            `${t('applied')}: ${resolved.dbFile ?? ''} · ${resolved.envFile ?? ''} · ${resolved.base ?? ''}`,
          ),
          h('div', { className: 'dshhw-note' }, t('saveNote')),
          h(
            'div',
            { className: 'dshhw-actions' },
            h(
              'button',
              { type: 'button', className: 'dshhw-btn dshhw-btn-primary', disabled: busy || data?.editable === false, onClick: save },
              busy ? t('saving') : t('save'),
            ),
            h(
              'button',
              { type: 'button', className: 'dshhw-btn', disabled: busy || initial === undefined, onClick: () => setDraft(initial) },
              t('reset'),
            ),
            h('span', { className: 'dshhw-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dshhw-btn',
                disabled: running || (mode !== 'artifact' && texts.contextReady === false),
                onClick: mode === 'artifact' ? provisionNow : deployNow,
              },
              running
                ? mode === 'artifact'
                  ? t('provisioning')
                  : t('deploying')
                : mode === 'artifact'
                  ? t('provision')
                  : t('deploy'),
            ),
          ),
          data?.editable === false ? h('div', { className: 'dshhw-warn' }, t('editBlocked')) : null,
          error === undefined ? null : h('div', { className: 'dshhw-error' }, error),
          notice === undefined ? null : h('div', { className: 'dshhw-ok' }, notice),
        ),

        // Copyable deploy material; artifact mode has nothing to copy, its action is on the button.
        mode === 'artifact' ? null : h(
          'div',
          { className: 'dshhw-section' },
          h(
            'div',
            { className: 'dshhw-row' },
            h(
              'div',
              { className: 'dshhw-tabs', role: 'tablist' },
              ...blocks.map(([key, label]) =>
                h(
                  'button',
                  {
                    key,
                    type: 'button',
                    role: 'tab',
                    'aria-selected': key === active[0],
                    className: 'dshhw-tab',
                    onClick: () => setTab(key),
                  },
                  label,
                ),
              ),
            ),
            h('span', { className: 'dshhw-spacer' }),
            h('button', { type: 'button', className: 'dshhw-btn', onClick: () => copy(active[2] ?? '') }, t('copy')),
            copyNote === undefined ? null : h('span', { className: 'dshhw-note' }, copyNote),
          ),
          h('div', { className: 'dshhw-note' }, t('deployNote')),
          active[2]
            ? h('pre', { className: 'dshhw-code' }, active[2])
            : h('div', { className: 'dshhw-warn' }, t('loading')),
          h('textarea', {
            ref: clip,
            className: 'dshhw-clip',
            readOnly: true,
            value: copyRequest?.text ?? '',
            tabIndex: -1,
            'aria-hidden': true,
          }),
        ),

        // Deploy log
        deploy === undefined
          ? null
          : h(
              'div',
              { className: 'dshhw-section' },
              h(
                'div',
                { className: 'dshhw-row' },
                h('h4', null, t('deployLog')),
                h('span', { className: 'dshhw-spacer' }),
                running
                  ? h('span', { className: 'dshhw-note' }, jobKind === 'provision' ? t('provisioning') : t('deploying'))
                  : deploy.ok === true
                    ? h('span', { className: 'dshhw-ok' }, jobKind === 'provision' ? t('provisionDone') : t('deployDone'))
                    : h('span', { className: 'dshhw-error' }, jobKind === 'provision' ? t('provisionFailed') : t('deployFailed')),
              ),
              h('pre', { className: 'dshhw-code dshhw-log' }, deploy.text ?? ''),
            ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-horon: dictionaries')
        const t = ctx.locale.bind(NS)

        // Upper-left column entry; its id also addresses the `main` panel below.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('nav'), locale: NS },
            (owner = {}) => h(Mark, { size: owner.size ?? 18 }),
          ),
        )

        // `inject` supplies the component's props; without it the panel would
        // receive no `t` and every visible string would fall back to its key.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, Console),
        )

        // The settings row's navigation label is evaluated at registration time,
        // so it is bound separately from the slot's own `locale`.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'horon', order: 30, label: () => t('sectionTitle'), locale: NS },
            SettingsSection,
          ),
        )
      },
    }
  },
})