/**
 * dsh-dotnet-skills — Client half.
 *
 * One registration: a composer button in `conversation.input.left`. Clicking it
 * analyses the current project (host route) and opens a searchable panel with
 * the suggested skills. The dialog renders from this same component as a
 * fixed-position layer — the sibling screenshot plugin proves fixed children
 * escape the docked composer, while a second shell.overlay registration stayed
 * inactive in this host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dotnet-skills',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_ENDPOINT = '/dsh-dotnet-skills/state'
    const APPLY_ENDPOINT = '/dsh-dotnet-skills/apply'
    const CLEAR_ENDPOINT = '/dsh-dotnet-skills/clear'

    const STRINGS = {
      zh: {
        button: 'dotnet技能',
        buttonTitle: '按当前项目注入 .NET 技能',
        title: '注入 .NET 技能',
        analysing: '正在分析当前项目…',
        detected: '识别到',
        nothing: '没有识别到 .NET 技术栈',
        search: '搜索技能（名称 / 包 / 说明）',
        selected: '已选',
        inject: '注入',
        clear: '清空',
        cancel: '取消',
        empty: '没有匹配的技能',
        error: '出错了：',
        confirmHint: '写入 <项目>/.dsh/skills，仅本项目会话可见',
      },
      en: {
        button: 'dotnet skills',
        buttonTitle: 'Inject .NET skills for this project',
        title: 'Inject .NET skills',
        analysing: 'Analysing this project…',
        detected: 'Detected',
        nothing: 'No .NET stack recognised',
        search: 'Search skills (name, package, description)',
        selected: 'Selected',
        inject: 'Inject',
        clear: 'Clear',
        cancel: 'Cancel',
        empty: 'No matching skill',
        error: 'Failed: ',
        confirmHint: 'Writes <project>/.dsh/skills — only sessions in this project see them',
      },
    }

    function t() {
      const lang = typeof document === 'undefined' ? 'zh' : document.documentElement.lang || 'zh'
      return lang.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
    }

    const CSS = [
      '.dsdk-root{position:relative;display:inline-flex;align-items:center}',
      '.dsdk-btn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:0;border-radius:999px;',
      'background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;flex:none;',
      'font:inherit;font-size:12px;line-height:1;transition:background-color .15s ease,color .15s ease}',
      '.dsdk-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.dsdk-btn:focus-visible{outline:2px solid #512bd4;outline-offset:2px}',
      '.dsdk-btn[data-active="true"]{color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.dsdk-count{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;',
      'border-radius:999px;background:#512bd4;color:#fff;font-size:10px;font-weight:700}',
      '.dsdk-backdrop{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;',
      'animation:dsdk-fade .12s ease-out}',
      '.dsdk-panel{width:min(680px,92vw);max-height:min(76vh,720px);display:flex;flex-direction:column;border-radius:14px;',
      'background:var(--dsw-alias-bg-overlay,#1b1f26);color:var(--dsw-alias-label-primary,#e6e8ea);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 18px 60px rgba(0,0,0,.45);overflow:hidden}',
      '.dsdk-head{padding:14px 18px 8px;display:flex;flex-direction:column;gap:6px}',
      '.dsdk-title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}',
      '.dsdk-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a8);word-break:break-all}',
      '.dsdk-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}',
      '.dsdk-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-secondary,#a7adb6)}',
      '.dsdk-search{margin:6px 18px 8px;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.1));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}',
      '.dsdk-search input{flex:1;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;outline:none}',
      '.dsdk-list{flex:1;overflow:auto;padding:4px 10px 8px}',
      '.dsdk-row{display:flex;gap:10px;align-items:flex-start;padding:7px 8px;border-radius:8px;cursor:pointer}',
      '.dsdk-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}',
      '.dsdk-row input{margin-top:3px;accent-color:#512bd4}',
      '.dsdk-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#7f858e);margin-top:1px}',
      '.dsdk-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#a7adb6);margin-top:2px;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.dsdk-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}',
      '.dsdk-grow{flex:1}',
      '.dsdk-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#7f858e)}',
      '.dsdk-act{height:30px;padding:0 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));',
      'background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}',
      '.dsdk-act:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}',
      '.dsdk-act[data-primary="true"]{background:#512bd4;border-color:transparent;color:#fff;font-weight:600}',
      '.dsdk-act[data-primary="true"]:hover:not(:disabled){filter:brightness(1.1)}',
      '.dsdk-act:disabled{opacity:.5;cursor:default}',
      '.dsdk-loading{display:flex;flex-direction:column;align-items:center;gap:12px;padding:46px 20px}',
      '.dsdk-spin{width:26px;height:26px;border-radius:999px;border:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));',
      'border-top-color:#512bd4;animation:dsdk-rotate .8s linear infinite}',
      '.dsdk-error{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12.5px;padding:12px 18px}',
      '@keyframes dsdk-rotate{to{transform:rotate(360deg)}}',
      '@keyframes dsdk-fade{from{opacity:0}to{opacity:1}}',
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
    function IconDotnet(props) {
      const size = props && props.size ? props.size : 15
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 0.5, y: 0.5, width: 15, height: 15, rx: 4.4, fill: '#512BD4' }),
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

    function ComposerButton(props) {
      const sessionId = props && props.sessionId ? props.sessionId : null
      const strings = t()
      const [open, setOpen] = React.useState(false)
      const [phase, setPhase] = React.useState('idle') // idle | loading | ready | error
      const [panel, setPanel] = React.useState(null)
      const [error, setError] = React.useState('')
      const [count, setCount] = React.useState(0)
      const [query, setQuery] = React.useState('')
      const [selection, setSelection] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const searchRef = React.useRef(null)

      const applyPanel = React.useCallback((payload) => {
        setPanel(payload)
        setSelection(payload.injected.length > 0 ? payload.injected : payload.suggested)
        setCount(payload.injected.length)
      }, [])

      // Initial badge: how many skills this project already has.
      React.useEffect(() => {
        let cancelled = false
        if (sessionId === null) return undefined
        request(`${STATE_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`)
          .then((payload) => {
            if (cancelled || payload === null || payload.ok !== true) return
            setPanel(payload)
            setCount(payload.injected.length)
          })
          .catch(() => {
            /* the panel reports the real error when opened */
          })
        return () => {
          cancelled = true
        }
      }, [sessionId])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const openPanel = React.useCallback(async () => {
        setOpen(true)
        setPhase(panel !== null ? 'ready' : 'loading')
        setError('')
        if (sessionId === null) {
          setError('this session has no id')
          setPhase('error')
          return
        }
        setPhase('loading')
        try {
          const payload = await request(`${STATE_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`)
          if (payload === null || payload.ok !== true) throw new Error(payload?.error ?? 'no panel data')
          applyPanel(payload)
          setQuery('')
          setPhase('ready')
          window.setTimeout(() => searchRef.current?.focus(), 30)
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
          setPhase('error')
        }
      }, [sessionId, panel, applyPanel])

      const submit = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await request(APPLY_ENDPOINT, { sessionId, skills: selection })
          if (result && result.ok === true && result.panel) {
            applyPanel(result.panel)
            setOpen(false)
          } else {
            throw new Error(result?.error ?? 'apply failed')
          }
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
          setPhase('error')
        } finally {
          setBusy(false)
        }
      }, [busy, sessionId, selection, applyPanel])

      const clear = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await request(CLEAR_ENDPOINT, { sessionId })
          if (result && result.ok === true && result.panel) {
            applyPanel(result.panel)
            setSelection([])
            setOpen(false)
          } else {
            throw new Error(result?.error ?? 'clear failed')
          }
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
          setPhase('error')
        } finally {
          setBusy(false)
        }
      }, [busy, sessionId, applyPanel])

      const selectedSet = new Set(selection)
      const toggle = (name) => {
        setSelection((current) => (current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]))
      }

      const rows = React.useMemo(() => {
        if (panel === null) return []
        const needle = query.trim().toLowerCase()
        const suggested = new Set(panel.suggested)
        return panel.catalog
          .filter(
            (skill) =>
              needle === '' ||
              skill.name.toLowerCase().includes(needle) ||
              skill.package.toLowerCase().includes(needle) ||
              skill.description.toLowerCase().includes(needle),
          )
          .map((skill) => ({ ...skill, suggested: suggested.has(skill.name) }))
          .sort((left, right) => (left.suggested === right.suggested ? left.name.localeCompare(right.name) : left.suggested ? -1 : 1))
      }, [panel, query])

      const chosenTokens =
        panel === null ? 0 : selection.reduce((sum, name) => sum + (panel.catalog.find((skill) => skill.name === name)?.tokens ?? 0), 0)

      const dialog = !open
        ? null
        : h(
            'div',
            {
              className: 'dsdk-backdrop',
              onMouseDown: (event) => {
                if (event.target === event.currentTarget) setOpen(false)
              },
            },
            h(
              'div',
              { className: 'dsdk-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': strings.title },
              h(
                'div',
                { className: 'dsdk-head' },
                h('div', { className: 'dsdk-title' }, h(IconDotnet), h('span', null, strings.title), h('span', { className: 'dsdk-grow' })),
                panel && panel.project ? h('div', { className: 'dsdk-sub' }, `${panel.project.name} — ${panel.project.root}`) : null,
                panel && phase === 'ready'
                  ? h(
                      'div',
                      { className: 'dsdk-chips' },
                      h('span', { className: 'dsdk-chip' }, `${strings.detected}:`),
                      panel.detected.signals.length === 0
                        ? h('span', { className: 'dsdk-chip' }, strings.nothing)
                        : panel.detected.signals.map((signal) => h('span', { className: 'dsdk-chip', key: signal.id }, signal.label)),
                    )
                  : null,
              ),
              phase === 'loading'
                ? h('div', { className: 'dsdk-loading' }, h('div', { className: 'dsdk-spin' }), h('div', { className: 'dsdk-hint' }, strings.analysing))
                : phase === 'error'
                  ? h('div', { className: 'dsdk-error' }, `${strings.error}${error}`)
                  : h(
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
                          ? h('div', { className: 'dsdk-hint', style: { padding: '18px' } }, strings.empty)
                          : rows.map((skill) =>
                              h(
                                'label',
                                { className: 'dsdk-row', key: skill.name },
                                h('input', { type: 'checkbox', checked: selectedSet.has(skill.name), onChange: () => toggle(skill.name) }),
                                h(
                                  'span',
                                  { style: { minWidth: 0 } },
                                  h('span', { style: { fontSize: '13px' } }, skill.name),
                                  h('span', { className: 'dsdk-meta' }, ` · ${skill.package} · ≈${skill.tokens} tok`),
                                  skill.description ? h('span', { className: 'dsdk-desc' }, skill.description) : null,
                                ),
                              ),
                            ),
                      ),
                      h(
                        'div',
                        { className: 'dsdk-foot' },
                        h('span', { className: 'dsdk-hint' }, `${strings.selected} ${selection.length} · ≈${chosenTokens} tok`),
                        h('span', { className: 'dsdk-grow' }),
                        h('span', { className: 'dsdk-hint' }, strings.confirmHint),
                        h(
                          'button',
                          { type: 'button', className: 'dsdk-act', onClick: clear, disabled: busy || (panel ? panel.injected.length === 0 : true) },
                          strings.clear,
                        ),
                        h('button', { type: 'button', className: 'dsdk-act', onClick: () => setOpen(false), disabled: busy }, strings.cancel),
                        h(
                          'button',
                          { type: 'button', className: 'dsdk-act', 'data-primary': 'true', onClick: submit, disabled: busy },
                          `${strings.inject} ${selection.length}`,
                        ),
                      ),
                    ),
            ),
          )

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
            'data-active': count > 0 ? 'true' : 'false',
            onClick: openPanel,
          },
          h(IconDotnet),
          h('span', null, strings.button),
          count > 0 ? h('span', { className: 'dsdk-count' }, String(count)) : null,
        ),
        dialog,
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
      },
    }
  },
})
