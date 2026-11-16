/**
 * dsh-dotnet-skills — Client half.
 *
 * Two registrations, one shared store:
 *   conversation.input.left → the composer button (`技能`, with an injected count)
 *   shell.overlay           → the panel: analyse → searchable skill list → apply
 *
 * Clicking the button opens the panel in the frame-wide overlay seat (the docked
 * composer clips fixed children, and the slot's own documentation points overlays
 * here). The host analyses the project on every open, so the panel shows what it
 * actually recognised instead of a guess made when the plugin mounted.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dotnet-skills',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_ENDPOINT = '/dsh-dotnet-skills/state'
    const APPLY_ENDPOINT = '/dsh-dotnet-skills/apply'
    const CLEAR_ENDPOINT = '/dsh-dotnet-skills/clear'

    /** Shared panel state between the composer button and the overlay seat. */
    const store = {
      open: false,
      sessionId: null,
      revision: 0,
      listeners: new Set(),
      emit() {
        for (const listener of [...this.listeners]) {
          try {
            listener(this.revision)
          } catch {
            /* a broken listener must not break the panel */
          }
        }
      },
      patch(partial) {
        Object.assign(this, partial)
        this.revision += 1
        this.emit()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    const STRINGS = {
      zh: {
        button: '技能',
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
        live: '已注入',
        all: '全部技能',
        suggested: '建议',
        confirmHint: '确认后写入 <项目>/.dsh/skills，仅本项目会话可见',
      },
      en: {
        button: 'Skills',
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
        live: 'injected',
        all: 'All skills',
        suggested: 'Suggested',
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
      '.dsdk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.dsdk-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-pressed,rgba(127,127,127,.26))}',
      '.dsdk-btn:disabled{opacity:.45;cursor:default}',
      '.dsdk-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}',
      '.dsdk-btn[data-active="true"]{color:var(--dsw-alias-label-primary,#e6e8ea)}',
      '.dsdk-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;',
      'border-radius:999px;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;font-size:10px;font-weight:600}',
      '.dsdk-dot{width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.dsdk-backdrop{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;',
      'pointer-events:auto;animation:dsdk-fade .12s ease-out}',
      '.dsdk-panel{width:min(660px,92vw);max-height:min(76vh,720px);display:flex;flex-direction:column;border-radius:14px;',
      'background:var(--dsw-alias-bg-elevated,#1b1f26);color:var(--dsw-alias-label-primary,#e6e8ea);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 18px 60px rgba(0,0,0,.45);overflow:hidden}',
      '.dsdk-head{padding:16px 18px 10px;display:flex;flex-direction:column;gap:6px}',
      '.dsdk-title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}',
      '.dsdk-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a8);word-break:break-all}',
      '.dsdk-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}',
      '.dsdk-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-secondary,#a7adb6)}',
      '.dsdk-search{margin:6px 18px 8px;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;',
      'background:var(--dsw-alias-bg-sunken,rgba(127,127,127,.1));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}',
      '.dsdk-search input{flex:1;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;outline:none}',
      '.dsdk-list{flex:1;overflow:auto;padding:4px 10px 8px}',
      '.dsdk-row{display:flex;gap:10px;align-items:flex-start;padding:7px 8px;border-radius:8px;cursor:pointer}',
      '.dsdk-row:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.12))}',
      '.dsdk-row input{margin-top:3px;accent-color:var(--dsw-alias-brand-primary,#3b82f6)}',
      '.dsdk-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#7f858e);margin-top:1px}',
      '.dsdk-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#a7adb6);margin-top:2px;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.dsdk-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1))}',
      '.dsdk-grow{flex:1}',
      '.dsdk-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#7f858e)}',
      '.dsdk-act{height:30px;padding:0 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));',
      'background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}',
      '.dsdk-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.16))}',
      '.dsdk-act[data-primary="true"]{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent;color:#fff;font-weight:600}',
      '.dsdk-act[data-primary="true"]:hover:not(:disabled){filter:brightness(1.08)}',
      '.dsdk-act:disabled{opacity:.5;cursor:default}',
      '.dsdk-loading{display:flex;flex-direction:column;align-items:center;gap:12px;padding:46px 20px}',
      '.dsdk-spin{width:26px;height:26px;border-radius:999px;border:2px solid var(--dsw-alias-border-l1,rgba(255,255,255,.18));',
      'border-top-color:var(--dsw-alias-brand-primary,#3b82f6);animation:dsdk-rotate .8s linear infinite}',
      '.dsdk-error{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12.5px;padding:10px 18px}',
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

    function IconSkills() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M8 1.8 9.5 5l3.2.5-2.3 2.3.5 3.2L8 9.5 5.1 11l.5-3.2L3.3 5.5 6.5 5 8 1.8Z',
          stroke: 'currentColor',
          strokeWidth: 1.15,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M3.2 12.6h9.6', stroke: 'currentColor', strokeWidth: 1.15, strokeLinecap: 'round' }),
      )
    }

    function IconClose() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }

    async function request(url, body) {
      const options = body === undefined
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
      if (!response.ok) {
        const message = payload && payload.error ? payload.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload
    }

    /* ---------------------------------------------------------------- *
     * composer button
     * ---------------------------------------------------------------- */

    function ComposerButton(props) {
      const sessionId = props && props.sessionId ? props.sessionId : null
      const [, force] = React.useState(0)
      const [count, setCount] = React.useState(0)

      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [])

      React.useEffect(() => {
        let cancelled = false
        if (sessionId === null) return undefined
        request(`${STATE_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`)
          .then((panel) => {
            if (!cancelled && panel && panel.ok === true) setCount(panel.injected.length)
          })
          .catch(() => {
            /* the panel reports the real error when opened */
          })
        return () => {
          cancelled = true
        }
      }, [sessionId, store.revision])

      const strings = t()
      const active = count > 0
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
            'data-active': active ? 'true' : 'false',
            disabled: sessionId === null,
            onClick: () => store.patch({ open: true, sessionId }),
          },
          h(IconSkills),
          h('span', null, strings.button),
          active ? h('span', { className: 'dsdk-count' }, String(count)) : null,
        ),
      )
    }

    /* ---------------------------------------------------------------- *
     * panel
     * ---------------------------------------------------------------- */

    function SkillRow(props) {
      const { skill, checked, onToggle, strings } = props
      return h(
        'label',
        { className: 'dsdk-row' },
        h('input', { type: 'checkbox', checked, onChange: onToggle }),
        h(
          'span',
          { style: { minWidth: 0 } },
          h('span', { style: { fontSize: '13px' } }, skill.name),
          h('span', { className: 'dsdk-meta' }, ` · ${skill.package} · ≈${skill.tokens} tok`),
          skill.description ? h('span', { className: 'dsdk-desc' }, skill.description) : null,
        ),
      )
    }

    function Panel() {
      const [, force] = React.useState(0)
      const [phase, setPhase] = React.useState('idle') // idle | loading | ready | error
      const [panel, setPanel] = React.useState(null)
      const [error, setError] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [selection, setSelection] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const searchRef = React.useRef(null)

      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [])

      const strings = t()
      const open = store.open === true

      React.useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        setPhase('loading')
        setError('')
        setQuery('')
        request(`${STATE_ENDPOINT}?sessionId=${encodeURIComponent(store.sessionId ?? '')}`)
          .then((payload) => {
            if (cancelled) return
            if (payload === null || payload.ok !== true) {
              setError(payload?.error ?? 'no panel data')
              setPhase('error')
              return
            }
            setPanel(payload)
            setSelection(payload.injected.length > 0 ? payload.injected : payload.suggested)
            setPhase('ready')
            window.setTimeout(() => searchRef.current?.focus(), 30)
          })
          .catch((failure) => {
            if (cancelled) return
            setError(failure?.message ?? String(failure))
            setPhase('error')
          })
        return () => {
          cancelled = true
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            store.patch({ open: false })
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      const close = () => store.patch({ open: false })

      const selectedSet = new Set(selection)
      const toggle = (name) => {
        setSelection((current) => (current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name]))
      }

      const rows = React.useMemo(() => {
        if (panel === null) return []
        const needle = query.trim().toLowerCase()
        const suggested = new Set(panel.suggested)
        const list = panel.catalog
          .filter((skill) => needle === '' || skill.name.toLowerCase().includes(needle) || skill.package.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))
          .map((skill) => ({ ...skill, suggested: suggested.has(skill.name) }))
        list.sort((left, right) => {
          if (left.suggested !== right.suggested) return left.suggested ? -1 : 1
          return left.name.localeCompare(right.name)
        })
        return list
      }, [panel, query])

      const chosenTokens = panel === null
        ? 0
        : selection.reduce((sum, name) => sum + (panel.catalog.find((skill) => skill.name === name)?.tokens ?? 0), 0)

      const submit = async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await request(APPLY_ENDPOINT, { sessionId: store.sessionId, skills: selection })
          if (result && result.ok === true) {
            setPanel(result.panel)
            store.patch({ open: false })
          } else {
            throw new Error(result?.error ?? 'apply failed')
          }
        } catch (failure) {
          setError(failure?.message ?? String(failure))
          setPhase('error')
        } finally {
          setBusy(false)
        }
      }

      const clear = async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await request(CLEAR_ENDPOINT, { sessionId: store.sessionId })
          if (result && result.ok === true) {
            setSelection([])
            setPanel(result.panel)
            store.patch({ open: false })
          } else {
            throw new Error(result?.error ?? 'clear failed')
          }
        } catch (failure) {
          setError(failure?.message ?? String(failure))
          setPhase('error')
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        {
          className: 'dsdk-backdrop',
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
              { className: 'dsdk-title' },
              h(IconSkills),
              h('span', null, strings.title),
              h('span', { className: 'dsdk-grow' }),
              h('button', { type: 'button', className: 'dsdk-act', style: { height: 24, padding: '0 8px' }, onClick: close, title: strings.cancel }, h(IconClose)),
            ),
            panel && panel.project
              ? h('div', { className: 'dsdk-sub' }, `${panel.project.name} — ${panel.project.root}`)
              : null,
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
            ? h(
                'div',
                { className: 'dsdk-loading' },
                h('div', { className: 'dsdk-spin' }),
                h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary,#a7adb6)' } }, strings.analysing),
              )
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
                    ? h('div', { className: 'dsdk-hint', style: { padding: '18px' } }, strings.empty)
                    : rows.map((skill) =>
                        h(SkillRow, {
                          key: skill.name,
                          skill,
                          strings,
                          checked: selectedSet.has(skill.name),
                          onToggle: () => toggle(skill.name),
                        }),
                      ),
                ),
                h(
                  'div',
                  { className: 'dsdk-foot' },
                  h('span', { className: 'dsdk-hint' }, `${strings.selected} ${selection.length} · ≈${chosenTokens} tok`),
                  h('span', { className: 'dsdk-grow' }),
                  h('span', { className: 'dsdk-hint' }, strings.confirmHint),
                  h('button', { type: 'button', className: 'dsdk-act', onClick: clear, disabled: busy || panel.injected.length === 0 }, strings.clear),
                  h('button', { type: 'button', className: 'dsdk-act', onClick: close, disabled: busy }, strings.cancel),
                  h('button', { type: 'button', className: 'dsdk-act', 'data-primary': 'true', onClick: submit, disabled: busy }, `${strings.inject} ${selection.length}`),
                ),
              )
            : null,
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
              id: 'dsh-dotnet-skills.panel',
              order: 10,
            },
            Panel,
          ),
        )
      },
    }
  },
})
