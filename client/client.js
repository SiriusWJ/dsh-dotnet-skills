/**
 * dsh-dotnet-skills — Client half.
 *
 * Three registrations, one tiny store:
 *   conversation.input.left → the composer button (`dotnet技能`, with a count badge)
 *   shell.overlay           → the dialog layer (frame-wide, above every column)
 *   plugins.bundle.config   → this bundle's settings, on Plugins → Installed
 *
 * The dialog lives in shell.overlay rather than inside the composer: a fixed
 * child of the docked composer is positioned against its transformed ancestor
 * and lands on top of the input. The overlay occupant always renders a wrapper,
 * so the cell stays active even while the dialog is closed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dotnet-skills',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_ENDPOINT = '/dsh-dotnet-skills/state'
    const APPLY_ENDPOINT = '/dsh-dotnet-skills/apply'
    const CLEAR_ENDPOINT = '/dsh-dotnet-skills/clear'
    const SETTINGS_ENDPOINT = '/dsh-dotnet-skills/settings'
    const LEARN_ENDPOINT = '/dsh-dotnet-skills/learn'
    const BRAND = '#512bd4'

    /** Panel state shared by the composer button and the overlay dialog. */
    const store = {
      open: false,
      sessionId: null,
      revision: 0,
      listeners: new Set(),
      patch(partial) {
        Object.assign(this, partial)
        this.revision += 1
        for (const listener of [...this.listeners]) {
          try {
            listener(this.revision)
          } catch {
            /* one broken listener must not break the panel */
          }
        }
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    const STRINGS = {
      zh: {
        button: 'dotnet技能',
        buttonTitle: '按当前项目注入 .NET 技能',
        title: '注入 .NET 技能',
        analysing: 'AI 正在挑选合适的技能…',
        detected: '识别到',
        nothing: '没有识别到 .NET 技术栈',
        search: '搜索技能（名称 / 包 / 说明）',
        selected: '已选',
        inject: '注入',
        clear: '清空',
        cancel: '取消',
        refresh: '重新分析',
        empty: '没有匹配的技能',
        error: '出错了：',
        suggestedTag: 'AI 推荐',
        existing: '已选技能',
        refreshInterval: '刷新频率',
        maxPicks: '最大自动推荐',
        save: '保存',
        savedNotice: '已保存',
        rejectedNotice: '未保存：值被拒绝',
        cfgUnavailable: '当前配置不可编辑',
        cfgHint: '保存后会重启该插件并立即生效',
        hoursUnit: '小时',
        dayUnit: '天',
        weekUnit: '周',
        noDotnet: '这个项目里没有 .NET 痕迹',
        unavailable: '模型暂不可用，可手动搜索选择',
        sessionLabel: '会话目录',
        scopeLabel: '分析范围',
        skillRootLabel: '技能写入',
        confirmHint: '写入 <项目>/.dsh/Skills · 仅本项目会话可见',
        learnTitle: 'Microsoft Learn 集成',
        learnMcp: 'MCP 服务器（learn.microsoft.com/api/mcp）',
        learnCliShort: 'CLI',
        learnDetecting: '检测中…',
        learnInstalling: '正在安装…',
        learnInstalled: '已安装',
        learnNotInstalled: '未安装',
        learnActive: '已连接',
        learnInactive: '未连接',
        learnOff: '已关闭',
        learnError: '连接失败',
        enabled: '启用',
        disabled: '停用',
      },
      en: {
        button: 'dotnet skills',
        buttonTitle: 'Inject .NET skills for this project',
        title: 'Inject .NET skills',
        analysing: 'The model is picking skills…',
        detected: 'Detected',
        nothing: 'No .NET stack recognised',
        search: 'Search skills (name, package, description)',
        selected: 'Selected',
        inject: 'Inject',
        clear: 'Clear',
        cancel: 'Cancel',
        refresh: 'Re-analyse',
        empty: 'No matching skill',
        error: 'Failed: ',
        suggestedTag: 'AI pick',
        existing: 'current selection',
        refreshInterval: 'Refresh',
        maxPicks: 'Max suggestions',
        save: 'Save',
        savedNotice: 'saved',
        rejectedNotice: 'not saved: value rejected',
        cfgUnavailable: 'this configuration is not editable here',
        cfgHint: 'saving restarts the plugin and applies at once',
        hoursUnit: 'h',
        dayUnit: 'day',
        weekUnit: 'week',
        noDotnet: 'No .NET traces in this project',
        unavailable: 'The model is unavailable — search and pick manually',
        sessionLabel: 'session',
        scopeLabel: 'analysed',
        skillRootLabel: 'skills',
        confirmHint: 'Writes <project>/.dsh/Skills · only sessions in this project see them',
        learnTitle: 'Microsoft Learn',
        learnMcp: 'MCP server (learn.microsoft.com/api/mcp)',
        learnCliShort: 'CLI',
        learnDetecting: 'checking…',
        learnInstalling: 'installing…',
        learnInstalled: 'installed',
        learnNotInstalled: 'not installed',
        learnActive: 'connected',
        learnInactive: 'not connected',
        learnOff: 'off',
        learnError: 'failed',
        enabled: 'on',
        disabled: 'off',
      },
    }

    /** Language code for host requests: the reasons must match the UI language. */
    function uiLang() {
      const lang = typeof document === 'undefined' ? 'zh' : document.documentElement.lang || 'zh'
      return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function t() {
      return uiLang() === 'zh' ? STRINGS.zh : STRINGS.en
    }

    /** Small status chip: which model picked the skills, and how long it took. */
    function analysisLabel(panel, strings) {
      const analysis = panel && panel.analysis
      if (!analysis) return ''
      if (analysis.source === 'model') {
        const seconds = analysis.durationMs ? `${(analysis.durationMs / 1000).toFixed(1)}s` : ''
        const cached = analysis.cached ? 'cache' : ''
        return ['AI', cached, seconds].filter((part) => part !== '').join(' · ')
      }
      if (analysis.source === 'existing') return strings.existing
      if (analysis.source === 'skipped') return strings.noDotnet
      if (analysis.source === 'unavailable') return strings.unavailable
      return analysis.note || ''
    }

    const CSS = [
      /* composer button */
      '.dsdk-root{position:relative;display:inline-flex;align-items:center}',
      '.dsdk-btn{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 9px 0 6px;border:0;border-radius:999px;',
      'background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;flex:none;',
      'font:inherit;font-size:12.5px;line-height:1;transition:background-color .15s ease,color .15s ease}',
      '.dsdk-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.dsdk-btn:focus-visible{outline:2px solid ' + BRAND + ';outline-offset:2px}',
      '.dsdk-btn[data-active="true"]{color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.dsdk-count{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;',
      'border-radius:999px;background:' + BRAND + ';color:#fff;font-size:10px;font-weight:700;font-variant-numeric:tabular-nums}',

      /* dialog */
      '.dsdk-layer{position:fixed;inset:0;z-index:1400;pointer-events:auto;display:flex;align-items:center;justify-content:center;',
      'background:rgba(6,8,12,.58);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:dsdk-fade .14s ease-out}',
      '.dsdk-panel{width:min(720px,92vw);max-height:min(78vh,760px);display:flex;flex-direction:column;border-radius:16px;',
      'background:var(--dsw-alias-bg-layer-1,#1c2129);',
      'background-image:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,0) 140px);',
      'color:var(--dsw-alias-label-primary,#e9ebee);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));box-shadow:0 24px 80px rgba(0,0,0,.6),0 2px 10px rgba(0,0,0,.4);',
      'overflow:hidden;animation:dsdk-pop .16s cubic-bezier(.2,.8,.3,1)}',
      '.dsdk-head{padding:18px 20px 12px;display:flex;flex-direction:column;gap:7px}',
      '.dsdk-headrow{display:flex;align-items:center;gap:10px}',
      '.dsdk-title{font-size:15.5px;font-weight:650;letter-spacing:.2px;display:flex;align-items:center;gap:9px}',
      '.dsdk-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#98a0aa);word-break:break-all}',
      '.dsdk-close{display:grid;place-items:center;width:26px;height:26px;border:0;border-radius:8px;',
      'background:transparent;color:var(--dsw-alias-label-secondary,#98a0aa);cursor:pointer}',
      '.dsdk-close:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#e9ebee)}',
      '.dsdk-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 20px 4px}',
      '.dsdk-chip{font-size:11px;line-height:18px;padding:1px 9px;border-radius:999px;',
      'background:rgba(129,140,248,.16);color:var(--dsw-alias-label-primary,#cfd4dc);border:1px solid rgba(129,140,248,.28)}',
      '.dsdk-chip-label{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary,#98a0aa);padding-left:0}',
      '.dsdk-search{margin:8px 20px 10px;display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.1));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));',
      'transition:border-color .15s ease,box-shadow .15s ease}',
      '.dsdk-search:focus-within{border-color:rgba(129,140,248,.55);box-shadow:0 0 0 3px rgba(81,43,212,.18)}',
      '.dsdk-search input{flex:1;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;outline:none}',
      '.dsdk-search input::placeholder{color:var(--dsw-alias-label-secondary,#8b929b)}',
      '.dsdk-list{flex:1;overflow:auto;padding:2px 12px 10px;scrollbar-width:thin;',
      'scrollbar-color:rgba(190,196,208,.45) rgba(255,255,255,.05)}',
      '.dsdk-list::-webkit-scrollbar{width:10px}',
      '.dsdk-list::-webkit-scrollbar-track{background:rgba(255,255,255,.05);border-radius:999px}',
      '.dsdk-list::-webkit-scrollbar-thumb{background:rgba(190,196,208,.42);border-radius:999px;border:2px solid transparent;',
      'background-clip:content-box}',
      '.dsdk-list::-webkit-scrollbar-thumb:hover{background:rgba(210,216,228,.62);background-clip:content-box}',
      '.dsdk-row{display:flex;gap:11px;align-items:flex-start;padding:9px 10px;border-radius:10px;cursor:pointer;',
      'border:1px solid transparent;transition:background-color .12s ease,border-color .12s ease}',
      '.dsdk-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.13));border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
      '.dsdk-row[data-checked="true"]{background:rgba(81,43,212,.12);border-color:rgba(129,140,248,.32)}',
      '.dsdk-row input{margin-top:3px;accent-color:' + BRAND + ';width:14px;height:14px;flex:none}',
      '.dsdk-name{font-size:13px;font-weight:550}',
      '.dsdk-why{font-size:11.5px;color:#a99cf5;margin-top:2px}',
      '.dsdk-analysis{font-size:10.5px;background:rgba(129,140,248,.14);border-color:transparent;',
      'color:var(--dsw-alias-label-secondary,#98a0aa);max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsdk-tag{font-size:10px;font-weight:600;letter-spacing:.4px;padding:1px 6px;border-radius:6px;margin-left:8px;',
      'background:rgba(129,140,248,.2);color:#c7c9ff;text-transform:uppercase}',
      '.dsdk-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#8b929b);margin-top:2px}',
      '.dsdk-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#a3aab4);margin-top:3px;line-height:1.45;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.dsdk-foot{display:flex;align-items:center;gap:10px;padding:13px 20px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));',
      'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02));flex-wrap:wrap;row-gap:8px}',
      '.dsdk-grow{flex:1 1 auto;min-width:8px}',
      '.dsdk-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8b929b);min-width:0;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsdk-tokens{font-variant-numeric:tabular-nums}',
      '.dsdk-act{height:31px;padding:0 15px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));',
      'background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;transition:background-color .15s ease,filter .15s ease}',
      '.dsdk-act:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18))}',
      '.dsdk-act[data-primary="true"]{background:' + BRAND + ';border-color:transparent;color:#fff;font-weight:600}',
      '.dsdk-act[data-primary="true"]:hover:not(:disabled){filter:brightness(1.12)}',
      '.dsdk-act[data-danger="true"]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#ff6b6b)}',
      '.dsdk-act:disabled{opacity:.45;cursor:default}',
      '.dsdk-loading{display:flex;flex-direction:column;align-items:center;gap:14px;padding:54px 20px}',
      '.dsdk-spin{width:28px;height:28px;border-radius:999px;border:2.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));',
      'border-top-color:' + BRAND + ';animation:dsdk-rotate .8s linear infinite}',
      '.dsdk-error{margin:14px 20px 18px;padding:12px 14px;border-radius:10px;font-size:12.5px;line-height:1.5;',
      'background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.3);color:var(--dsw-alias-state-error-primary,#ff6b6b)}',

      /* Microsoft Learn control in the panel header (per working directory) */
      '.dsdk-headright{margin-left:auto;display:flex;align-items:center;gap:10px}',
      '.dsdk-learn-pill{display:flex;align-items:center;gap:9px;padding:3px 5px 3px 11px;border-radius:999px;',
      'border:1px solid rgba(129,140,248,.32);background:rgba(81,43,212,.14);transition:border-color .15s ease,background-color .15s ease}',
      '.dsdk-learn-pill[data-on="true"]{border-color:rgba(129,140,248,.6);background:rgba(81,43,212,.26)}',
      '.dsdk-learn-label{font-size:11.5px;font-weight:650;letter-spacing:.2px;white-space:nowrap;flex:none}',
      '.dsdk-learn-state{font-size:11px;color:var(--dsw-alias-label-secondary,#98a0aa);min-width:0;max-width:210px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      /* settings card (Plugins → Installed) */
      '.dsdk-cfg{display:flex;flex-direction:column;gap:12px;width:100%;max-width:640px}',
      '.dsdk-cfg-group{display:flex;flex-direction:column;gap:10px;padding:13px 15px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05))}',
      '.dsdk-cfg-head{font-size:12px;font-weight:650;letter-spacing:.3px;text-transform:uppercase;',
      'color:var(--dsw-alias-label-secondary,#98a0aa)}',
      '.dsdk-cfg-row{display:grid;grid-template-columns:minmax(0,1fr) 184px;align-items:center;',
      'column-gap:16px;row-gap:6px;font-size:13px}',
      '.dsdk-cfg-row> :last-child{justify-self:stretch}',
      '.dsdk-cfg-row[data-kind="switch"]> :last-child{justify-self:end}',
      '.dsdk-cfg-label{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsdk-cfg-help{font-size:11px;color:var(--dsw-alias-label-secondary,#8b929b);overflow-wrap:anywhere}',
      '.dsdk-cfg-select,.dsdk-cfg-input{box-sizing:border-box;width:100%;height:32px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:inherit;font:inherit;font-size:12.5px;padding:0 8px}',
      '.dsdk-cfg-input{text-align:right}',
      '.dsdk-cfg-select:focus,.dsdk-cfg-input:focus{outline:none;border-color:rgba(129,140,248,.6);box-shadow:0 0 0 3px rgba(81,43,212,.18)}',
      '.dsdk-cfg-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8b929b);margin:0}',
      '.dsdk-cfg-ok{color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dsdk-cfg-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsdk-cfg-save{height:30px;padding:0 14px;border-radius:8px;border:0;background:' + BRAND + ';color:#fff;font:inherit;',
      'font-size:12.5px;font-weight:600;cursor:pointer}',
      '.dsdk-cfg-save:disabled{opacity:.45;cursor:default}',
      'background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}',
      '.dsdk-switch{position:relative;display:inline-flex;align-items:center;width:46px;height:26px;border-radius:999px;',
      'border:1px solid rgba(255,255,255,.3);box-sizing:border-box;padding:0;cursor:pointer;flex:none;',
      'background:rgba(255,255,255,.16);box-shadow:inset 0 1px 2px rgba(0,0,0,.35);transition:background-color .15s ease,border-color .15s ease}',
      '.dsdk-switch:hover:not(:disabled){border-color:rgba(255,255,255,.5)}',
      '.dsdk-switch[data-on="true"]{background:' + BRAND + ';border-color:' + BRAND + '}',
      '.dsdk-switch span{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:999px;background:#fff;',
      'box-shadow:0 1px 3px rgba(0,0,0,.45);transition:transform .16s ease}',
      '.dsdk-switch[data-on="true"] span{transform:translateX(20px)}',
      '.dsdk-switch:disabled{opacity:.45;cursor:default}',

      '@keyframes dsdk-rotate{to{transform:rotate(360deg)}}',
      '@keyframes dsdk-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes dsdk-pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}',
    ].join('')

    function installStyles() {
      const marker = 'dsh-dotnet-skills'
      const existing = document.querySelector(`style[data-plugin-css="${marker}"]`)
      if (existing) return () => existing.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = marker
      tag.dataset.pluginCss = marker
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /** The .NET mark as geometry: a stroked N stays crisp where a tiny wordmark blurs. */
    /** One line describing the Microsoft Learn server and its CLI for the current project. */
    function learnStateText(panel, strings) {
      const learn = (panel && panel.learn) || {}
      const cli = learn.cli || {}
      const cliText = cli.busy
        ? strings.learnInstalling
        : cli.installed === true
          ? strings.learnInstalled
          : cli.installed === false
            ? strings.learnNotInstalled
            : strings.learnDetecting
      if (panel.learnMcp !== true) return `${strings.learnOff} · ${strings.learnCliShort}: ${cliText}`
      if (learn.error) return String(learn.error)
      return `${learn.active === true ? strings.learnActive : strings.learnInactive} · ${strings.learnCliShort}: ${cliText}`
    }

    /** Short label for the header pill; the full detail lives in its tooltip. */
    function learnShort(panel, strings) {
      if (panel.learnMcp !== true) return strings.learnOff
      if (panel.learn && panel.learn.error) return strings.learnError
      return panel.learn && panel.learn.active === true ? strings.learnActive : strings.learnInactive
    }

    function IconDotnet(props) {
      const size = props && props.size ? props.size : 15
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 0.5, y: 0.5, width: 15, height: 15, rx: 4.4, fill: BRAND }),
        h('path', {
          d: 'M5.1 11.4V4.6L10.9 11.4V4.6',
          fill: 'none',
          stroke: '#ffffff',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function IconClose() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    /** Localized interval label: the host returns hours, the panel speaks the UI language. */
    function intervalText(hours, strings) {
      const value = Number(hours)
      if (value >= 168) return `1 ${strings.weekUnit}`
      if (value >= 72) return `${Math.round(value / 24)} ${strings.dayUnit}`
      if (value >= 24) return `1 ${strings.dayUnit}`
      return `${value} ${strings.hoursUnit}`
    }

    async function request(url, body) {
      const options =
        body === undefined
          ? { method: 'GET', credentials: 'same-origin' }
          : {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
      const response = await fetch(url, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
      return payload
    }

    /* ---------------------------------------------------------------- *
     * composer button
     * ---------------------------------------------------------------- */

    function ComposerButton(props) {
      const sessionId = props && props.sessionId ? props.sessionId : null
      const strings = t()
      const [count, setCount] = React.useState(0)
      const [revision, bump] = React.useState(0)

      React.useEffect(() => store.subscribe(() => bump((value) => value + 1)), [])

      React.useEffect(() => {
        let cancelled = false
        if (sessionId === null) return undefined
        request(`${STATE_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}&lang=${uiLang()}`)
          .then((payload) => {
            if (cancelled || payload === null || payload.ok !== true) return
            setCount(payload.injected.length)
          })
          .catch(() => {
            /* the dialog reports the real error when opened */
          })
        return () => {
          cancelled = true
        }
      }, [sessionId, revision, store.open])

      return h(
        'div',
        { className: 'dsdk-root' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsdk-btn',
            title: strings.buttonTitle,
            'aria-label': strings.buttonTitle,
            'aria-expanded': store.open ? 'true' : 'false',
            'data-active': count > 0 ? 'true' : 'false',
            onClick: () => store.patch({ open: !store.open, sessionId }),
          },
          h(IconDotnet),
          h('span', null, strings.button),
          count > 0 ? h('span', { className: 'dsdk-count' }, String(count)) : null,
        ),
      )
    }

    /* ---------------------------------------------------------------- *
     * overlay dialog
     * ---------------------------------------------------------------- */

    function Dialog() {
      const strings = t()
      const [revision, bump] = React.useState(0)
      const [phase, setPhase] = React.useState('idle') // idle | loading | ready | error
      const [panel, setPanel] = React.useState(null)
      const [error, setError] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [selection, setSelection] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [learnBusy, setLearnBusy] = React.useState(false)
      const searchRef = React.useRef(null)

      React.useEffect(() => store.subscribe(() => bump((value) => value + 1)), [])

      const open = store.open === true
      const sessionId = store.sessionId

      const applyPanel = React.useCallback((payload) => {
        setPanel(payload)
        setSelection(payload.injected.length > 0 ? payload.injected : payload.suggested)
      }, [])

      /** One load; `refresh` bypasses both the cache and the "already chosen" shortcut. */
      const load = React.useCallback(
        async (options) => {
          const refresh = options !== undefined && options.refresh === true
          setPhase('loading')
          setError('')
          if (sessionId === null || sessionId === undefined) {
            setError('no live session id was passed to the panel')
            setPhase('error')
            return
          }
          try {
            const payload = await request(
              `${STATE_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}&lang=${uiLang()}${refresh ? '&refresh=1' : ''}`,
            )
            if (payload === null || payload.ok !== true) throw new Error(payload?.error ?? 'no panel data')
            applyPanel(payload)
            if (!refresh) setQuery('')
            setPhase('ready')
            window.setTimeout(() => {
              if (searchRef.current) searchRef.current.focus()
            }, 40)
          } catch (failure) {
            setError(failure && failure.message ? failure.message : String(failure))
            setPhase('error')
          }
        },
        [sessionId, applyPanel],
      )

      React.useEffect(() => {
        if (!open) return undefined
        void load({ refresh: false })
        return undefined
      }, [open, sessionId, load])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') store.patch({ open: false })
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const close = () => store.patch({ open: false })

      const submit = async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await request(APPLY_ENDPOINT, { sessionId, skills: selection, lang: uiLang() })
          if (result && result.ok === true && result.panel) {
            applyPanel(result.panel)
            store.patch({ open: false })
          } else {
            throw new Error(result?.error ?? 'apply failed')
          }
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
          setPhase('error')
        } finally {
          setBusy(false)
        }
      }

      const clear = async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await request(CLEAR_ENDPOINT, { sessionId, lang: uiLang() })
          if (result && result.ok === true && result.panel) {
            applyPanel(result.panel)
            setSelection([])
            store.patch({ open: false })
          } else {
            throw new Error(result?.error ?? 'clear failed')
          }
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
          setPhase('error')
        } finally {
          setBusy(false)
        }
      }

      /** The Learn server is per working directory: this writes this project's choice. */
      const toggleLearn = async (next) => {
        if (learnBusy || sessionId === null || sessionId === undefined) return
        setLearnBusy(true)
        try {
          const result = await request(LEARN_ENDPOINT, { sessionId, enabled: next, lang: uiLang() })
          if (result && result.ok === true) {
            setPanel((current) => (current === null ? current : { ...current, learnMcp: result.learnMcp, learn: result.learn }))
          } else {
            throw new Error(result?.error ?? 'could not change the Microsoft Learn server')
          }
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        } finally {
          setLearnBusy(false)
        }
      }

      const toggle = (name) => {
        setSelection((current) => (current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]))
      }

      const rows = React.useMemo(() => {
        if (panel === null) return []
        const needle = query.trim().toLowerCase()
        const suggested = new Set(panel.analysis && panel.analysis.source === 'model' ? panel.suggested : [])
        const checked = new Set(selection)
        return panel.catalog
          .filter(
            (skill) =>
              needle === '' ||
              skill.name.toLowerCase().includes(needle) ||
              skill.package.toLowerCase().includes(needle) ||
              skill.description.toLowerCase().includes(needle),
          )
          .map((skill) => ({
            ...skill,
            suggested: suggested.has(skill.name),
            checked: checked.has(skill.name),
            reason: (panel.reasons && panel.reasons[skill.name]) || '',
          }))
          .sort((left, right) => {
            // Chosen rows stay on top; suggested ones follow; the rest stays alphabetical.
            if (left.checked !== right.checked) return left.checked ? -1 : 1
            if (left.suggested !== right.suggested) return left.suggested ? -1 : 1
            return left.name.localeCompare(right.name)
          })
      }, [panel, query, selection])

      const chosenTokens =
        panel === null ? 0 : selection.reduce((sum, name) => sum + (panel.catalog.find((skill) => skill.name === name)?.tokens ?? 0), 0)

      // The wrapper always renders: an empty cell would report itself inactive.
      return h(
        'div',
        { className: 'dsdk-root', 'data-open': open ? 'true' : 'false' },
        open
          ? h(
              'div',
              {
                className: 'dsdk-layer',
                onMouseDown: (event) => {
                  if (event.target === event.currentTarget) close()
                },
              },
              h(
                'div',
                { className: 'dsdk-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': strings.title },
                h(
                  'div',
                  { className: 'dsdk-head' },
                  h(
                    'div',
                    { className: 'dsdk-headrow' },
                    h('div', { className: 'dsdk-title' }, h(IconDotnet, { size: 18 }), h('span', null, strings.title)),
                    h(
                      'span',
                      { className: 'dsdk-chip dsdk-chip-label dsdk-analysis', title: panel && panel.analysis ? panel.analysis.note || '' : '' },
                      analysisLabel(panel, strings),
                    ),
                    h(
                      'div',
                      { className: 'dsdk-headright' },
                      panel && phase === 'ready'
                        ? h(
                            'div',
                            { className: 'dsdk-learn-pill', 'data-on': panel.learnMcp === true ? 'true' : 'false' },
                            h('span', { className: 'dsdk-learn-label' }, 'Microsoft Learn'),
                            h('span', { className: 'dsdk-learn-state', title: learnStateText(panel, strings) }, learnShort(panel, strings)),
                            h(Switch, {
                              checked: panel.learnMcp === true,
                              disabled: learnBusy,
                              label: strings.learnTitle,
                              onChange: toggleLearn,
                            }),
                          )
                        : null,
                      h('button', { type: 'button', className: 'dsdk-close', onClick: close, title: strings.cancel, 'aria-label': strings.cancel }, h(IconClose)),
                    ),
                  ),
                  panel && panel.project ? h('div', { className: 'dsdk-sub' }, `${panel.project.name} — ${panel.project.root}`) : null,
                  panel && panel.project && panel.project.cwd && panel.project.cwd !== panel.project.root
                    ? h('div', { className: 'dsdk-sub' }, `${strings.sessionLabel}: ${panel.project.cwd}`)
                    : null,
                  panel && panel.project && panel.project.catalogDir
                    ? h('div', { className: 'dsdk-sub' }, `${strings.skillRootLabel}: ${panel.project.catalogDir}`)
                    : null,
                  panel && panel.project && panel.project.scoped
                    ? h('div', { className: 'dsdk-sub' }, `${strings.scopeLabel}: ${panel.project.scope}`)
                    : null,
                ),
                panel && phase === 'ready'
                  ? h(
                      'div',
                      { className: 'dsdk-chips' },
                      h('span', { className: 'dsdk-chip dsdk-chip-label' }, `${strings.detected}:`),
                      panel.detected.signals.length === 0
                        ? h('span', { className: 'dsdk-chip' }, strings.nothing)
                        : panel.detected.signals.map((signal) => h('span', { className: 'dsdk-chip', key: signal.id }, signal.label)),
                    )
                  : null,
                phase === 'loading'
                  ? h('div', { className: 'dsdk-loading' }, h('div', { className: 'dsdk-spin' }), h('div', { className: 'dsdk-hint' }, strings.analysing))
                  : null,
                phase === 'error' ? h('div', { className: 'dsdk-error' }, `${strings.error}${error}`) : null,
                phase === 'ready'
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
                      h(
                        'div',
                        { className: 'dsdk-search' },
                        h('input', {
                          ref: searchRef,
                          type: 'search',
                          value: query,
                          placeholder: strings.search,
                          onChange: (event) => setQuery(event.target.value),
                        }),
                      ),
                      h(
                        'div',
                        { className: 'dsdk-list' },
                        rows.length === 0
                          ? h('div', { className: 'dsdk-hint', style: { padding: '26px 10px', textAlign: 'center' } }, strings.empty)
                          : rows.map((skill) =>
                              h(
                                'label',
                                { className: 'dsdk-row', key: skill.name, 'data-checked': skill.checked ? 'true' : 'false' },
                                h('input', {
                                  type: 'checkbox',
                                  checked: skill.checked,
                                  onChange: () => toggle(skill.name),
                                  'aria-label': skill.name,
                                }),
                                h(
                                  'span',
                                  { style: { minWidth: 0 } },
                                  h(
                                    'span',
                                    { className: 'dsdk-name' },
                                    skill.name,
                                    skill.suggested ? h('span', { className: 'dsdk-tag' }, strings.suggestedTag) : null,
                                  ),
                                  h('span', { className: 'dsdk-meta' }, `${skill.package} · ≈${skill.tokens} tok`),
                                  skill.reason ? h('span', { className: 'dsdk-why' }, skill.reason) : null,
                                  skill.description ? h('span', { className: 'dsdk-desc' }, skill.description) : null,
                                ),
                              ),
                            ),
                      ),
                      h(
                        'div',
                        { className: 'dsdk-foot' },
                        h(
                          'span',
                          { className: 'dsdk-hint dsdk-tokens' },
                          `${strings.selected} ${selection.length} · ≈${chosenTokens} tok`,
                        ),
                        h('span', { className: 'dsdk-grow' }),
                        panel && panel.settings
                          ? h(
                              'span',
                              { className: 'dsdk-hint', title: 'Plugins → Installed' },
                              `${strings.refreshInterval} ${intervalText(panel.settings.intervalHours, strings)} · ${strings.maxPicks} ${panel.settings.selectMaxSkills}`,
                            )
                          : null,
                        h('button', { type: 'button', className: 'dsdk-act', onClick: () => void load({ refresh: true }), disabled: busy }, strings.refresh),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsdk-act',
                            'data-danger': 'true',
                            onClick: clear,
                            disabled: busy || (panel ? panel.injected.length === 0 : true),
                          },
                          strings.clear,
                        ),
                        h('button', { type: 'button', className: 'dsdk-act', onClick: close, disabled: busy }, strings.cancel),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsdk-act',
                            'data-primary': 'true',
                            onClick: submit,
                            disabled: busy,
                            title: strings.confirmHint,
                          },
                          `${strings.inject} ${selection.length}`,
                        ),
                      ),
                    )
                  : null,
                phase === 'error'
                  ? h(
                      'div',
                      { className: 'dsdk-foot' },
                      h('span', { className: 'dsdk-grow' }),
                      h('button', { type: 'button', className: 'dsdk-act', onClick: close }, strings.cancel),
                    )
                  : null,
              ),
            )
          : null,
      )
    }

    /* ---------------------------------------------------------------- *
     * Plugins → Installed → this bundle's settings
     * ---------------------------------------------------------------- */

    const BUNDLE_KEY = 'dsh-dotnet-skills'
    const ROW_KEY = 'dsh-dotnet-skills#dotnet-skills'
    const FALLBACK_INTERVALS = [6, 12, 24, 72, 168]

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsdk-switch',
          'data-on': props.checked ? 'true' : 'false',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          disabled: props.disabled,
          onClick: () => props.onChange(!props.checked),
        },
        h('span', null),
      )
    }

    /**
     * The whole settings surface: the panel's two knobs and the Microsoft Learn
     * integrations. It talks to the plugin's own routes, so it does not depend on
     * the host handing this page a writable form.
     */
    function SettingsCard(props) {
      const strings = t()
      const [settings, setSettings] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')

      const read = (source) => ({
        intervalHours: Number(source.intervalHours) || FALLBACK_INTERVALS[0],
        selectMaxSkills: Number(source.selectMaxSkills) || 10,
      })

      const loadSettings = React.useCallback(async () => {
        try {
          const payload = await request(SETTINGS_ENDPOINT)
          if (payload === null || payload.ok !== true) return
          setSettings(payload.settings)
          setDraft((current) => current ?? read(payload.settings))
        } catch {
          /* the note below reports the failure when saving */
        }
      }, [])

      if (props && props.view === 'summary') {
        return h(
          'span',
          null,
          `${strings.refreshInterval} ${intervalText(settings ? settings.intervalHours : FALLBACK_INTERVALS[0], strings)} · ${strings.maxPicks} ${
            settings ? settings.selectMaxSkills : 10
          }`,
        )
      }
      if (draft === null || settings === null) {
        return h('p', { className: 'dsdk-cfg-note' }, strings.analysing)
      }

      const save = async () => {
        if (busy) return
        setBusy(true)
        setMessage('')
        try {
          const payload = await request(SETTINGS_ENDPOINT, { ...draft, lang: uiLang() })
          if (payload === null || payload.ok !== true) throw new Error(payload?.error ?? 'save failed')
          setSettings(payload.settings)
          setDraft(read(payload.settings))
          setMessage(strings.savedNotice)
        } catch (failure) {
          setMessage(failure && failure.message ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'dsdk-cfg' },
        h(
          'div',
          { className: 'dsdk-cfg-group' },
          h('div', { className: 'dsdk-cfg-head' }, strings.title),
          h(
            'div',
            { className: 'dsdk-cfg-row' },
            h('span', { className: 'dsdk-cfg-label' }, strings.refreshInterval),
            h(
              'select',
              {
                className: 'dsdk-cfg-select',
                value: String(draft.intervalHours),
                disabled: busy,
                onChange: (event) => setDraft({ ...draft, intervalHours: Number(event.target.value) }),
              },
              FALLBACK_INTERVALS.map((hours) => h('option', { key: hours, value: String(hours) }, intervalText(hours, strings))),
            ),
          ),
          h(
            'div',
            { className: 'dsdk-cfg-row' },
            h('span', { className: 'dsdk-cfg-label' }, strings.maxPicks),
            h('input', {
              className: 'dsdk-cfg-input',
              type: 'number',
              min: 1,
              max: 50,
              value: String(draft.selectMaxSkills),
              disabled: busy,
              onChange: (event) => setDraft({ ...draft, selectMaxSkills: Number(event.target.value) }),
            }),
          ),
        ),
        h(
          'div',
          { className: 'dsdk-cfg-actions' },
          h('button', { type: 'button', className: 'dsdk-cfg-save', disabled: busy, onClick: save }, strings.save),
          h('span', { className: 'dsdk-cfg-note' }, strings.cfgHint),
          message !== '' ? h('span', { className: 'dsdk-cfg-note dsdk-cfg-ok', role: 'status' }, message) : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'dsh-dotnet-skills: styles')
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-dotnet-skills',
              order: 12,
              label: () => t().button,
            },
            ComposerButton,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-dotnet-skills.dialog',
              order: 900,
            },
            Dialog,
          ),
        )
        // Plugins → Installed → dsh-dotnet-skills: settings live on the bundle page.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: BUNDLE_KEY,
              label: () => t().settings,
            },
            (props) => h(SettingsCard, props),
          ),
        )
        // The same form is reachable from the row's own page when the page offers one.
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: ROW_KEY,
              label: () => t().settings,
            },
            (props) => h(SettingsCard, props),
          ),
        )
      },
    }
  },
})
