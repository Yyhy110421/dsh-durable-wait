/**
 * dsh-durable-wait 浏览器半身：设置 → 守候。
 *
 * 只展示等待目标、状态、剩余时间和叫醒状态；不展示会话内容。
 */
window.__ModuleLoader__.load({
  id: 'dsh-durable-wait',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const card = {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '4px 2px 20px',
      maxWidth: 820,
      fontSize: 13,
      lineHeight: 1.55,
      color: 'inherit',
    }
    const row = { display: 'flex', flexDirection: 'column', gap: 6 }
    const label = { fontWeight: 600, opacity: 0.9 }
    const hint = { fontSize: 12, opacity: 0.65 }
    const control = {
      minHeight: 32,
      padding: '6px 8px',
      font: 'inherit',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid rgba(127,127,127,0.4)',
      borderRadius: 8,
      boxSizing: 'border-box',
    }
    const button = {
      alignSelf: 'flex-start',
      padding: '7px 18px',
      font: 'inherit',
      color: 'inherit',
      background: 'rgba(127,127,127,0.14)',
      border: '1px solid rgba(127,127,127,0.45)',
      borderRadius: 8,
      cursor: 'pointer',
    }
    const smallButton = { ...button, padding: '4px 10px', fontSize: 12 }
    const grid = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
      gap: 10,
    }
    const waitItem = {
      padding: '10px 12px',
      border: '1px solid rgba(127,127,127,0.25)',
      borderRadius: 8,
      background: 'rgba(127,127,127,0.05)',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' }

    function statusText(value) {
      if (value === 'active') return '等待中'
      if (value === 'fired') return '已触发'
      if (value === 'cancelled') return '已取消'
      if (value === 'expired') return '已超时'
      return String(value || '未知')
    }

    function deliveryText(value) {
      if (value === 'pending') return '待叫醒'
      if (value === 'delivered') return '已叫醒'
      if (value === 'undelivered') return '叫醒失败'
      return ''
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    function remaining(value) {
      if (typeof value !== 'number' || value <= 0) return ''
      const minutes = Math.ceil(value / 60000)
      if (minutes < 60) return minutes + ' 分钟'
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return hours + ' 小时' + (rest > 0 ? ' ' + rest + ' 分钟' : '')
    }

    function Panel() {
      const [state, setState] = React.useState({
        loading: true,
        saving: false,
        cancelling: '',
        settings: {
          defaultTimeoutMinutes: 30,
          pollSeconds: 2,
          autoWake: true,
          maxWaits: 50,
        },
        waits: [],
        message: '',
      })

      function applyBody(body) {
        if (!body || body.ok !== true) throw new Error((body && body.error) || '读取失败')
        const s = body.settings || {}
        setState((prev) => ({
          ...prev,
          loading: false,
          settings: {
            defaultTimeoutMinutes:
              typeof s.defaultTimeoutMinutes === 'number' ? s.defaultTimeoutMinutes : prev.settings.defaultTimeoutMinutes,
            pollSeconds: typeof s.pollSeconds === 'number' ? s.pollSeconds : prev.settings.pollSeconds,
            autoWake: s.autoWake !== false,
            maxWaits: typeof s.maxWaits === 'number' ? s.maxWaits : prev.settings.maxWaits,
          },
          waits: Array.isArray(body.waits) ? body.waits : [],
        }))
      }

      function load() {
        return fetch('/durable-wait/settings')
          .then((res) => res.json())
          .then(applyBody)
          .catch((error) => {
            setState((prev) => ({
              ...prev,
              loading: false,
              message: '读取失败：' + String(error && error.message ? error.message : error),
            }))
          })
      }

      React.useEffect(() => {
        let alive = true
        function safeLoad() {
          if (alive) void load()
        }
        safeLoad()
        const timer = setInterval(safeLoad, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      function save() {
        setState((prev) => ({ ...prev, saving: true, message: '' }))
        fetch('/durable-wait/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(state.settings),
        })
          .then((res) => res.json())
          .then((body) => {
            if (!body || body.ok !== true) throw new Error((body && body.error) || '保存失败')
            setState((prev) => ({ ...prev, saving: false, message: '已保存。' }))
            void load()
          })
          .catch((error) => {
            setState((prev) => ({
              ...prev,
              saving: false,
              message: '保存失败：' + String(error && error.message ? error.message : error),
            }))
          })
      }

      function cancel(id) {
        setState((prev) => ({ ...prev, cancelling: id, message: '' }))
        fetch('/durable-wait/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        })
          .then((res) => res.json())
          .then((body) => {
            if (!body || body.ok !== true) throw new Error((body && body.error) || '取消失败')
            setState((prev) => ({ ...prev, cancelling: '', message: '已取消。' }))
            void load()
          })
          .catch((error) => {
            setState((prev) => ({
              ...prev,
              cancelling: '',
              message: '取消失败：' + String(error && error.message ? error.message : error),
            }))
          })
      }

      const active = state.waits.filter((wait) => wait.status === 'active').length

      return h(
        'div',
        { style: card },
        h(
          'div',
          { style: row },
          h('div', { style: label }, '守候'),
          h(
            'div',
            { style: hint },
            '登记一次外部条件，条件成立后 DSH 自动叫醒会话。只读文件状态和进程是否存在；不杀进程、不改目标文件。',
          ),
        ),
        h(
          'div',
          { style: grid },
          h(
            'label',
            { style: row },
            h('span', { style: label }, '默认超时（分钟）'),
            h('input', {
              style: control,
              type: 'number',
              min: 1,
              max: 1440,
              value: state.settings.defaultTimeoutMinutes,
              onChange: (event) =>
                setState((prev) => ({
                  ...prev,
                  settings: { ...prev.settings, defaultTimeoutMinutes: Number(event.target.value) || 30 },
                })),
            }),
          ),
          h(
            'label',
            { style: row },
            h('span', { style: label }, '轮询间隔（秒）'),
            h('input', {
              style: control,
              type: 'number',
              min: 2,
              max: 60,
              value: state.settings.pollSeconds,
              onChange: (event) =>
                setState((prev) => ({
                  ...prev,
                  settings: { ...prev.settings, pollSeconds: Number(event.target.value) || 2 },
                })),
            }),
            h('span', { style: hint }, '默认 2 秒；只在宿主里读一次 stat / 进程存在性。'),
          ),
          h(
            'label',
            { style: row },
            h('span', { style: label }, '最多同时等待'),
            h('input', {
              style: control,
              type: 'number',
              min: 1,
              max: 200,
              value: state.settings.maxWaits,
              onChange: (event) =>
                setState((prev) => ({
                  ...prev,
                  settings: { ...prev.settings, maxWaits: Number(event.target.value) || 50 },
                })),
            }),
          ),
          h(
            'label',
            { style: { ...row, flexDirection: 'row', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: state.settings.autoWake,
              onChange: (event) =>
                setState((prev) => ({
                  ...prev,
                  settings: { ...prev.settings, autoWake: event.target.checked },
                })),
            }),
            h('span', null, '条件成立时自动叫醒会话'),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'center' } },
          h('button', { type: 'button', style: button, disabled: state.saving, onClick: save }, state.saving ? '保存中…' : '保存设置'),
          h('span', { style: hint }, state.message),
        ),
        h('div', { style: { ...row, marginTop: 4 } }, h('div', { style: label }, '等待列表（' + active + ' 条进行中）')),
        state.loading
          ? h('div', { style: hint }, '读取中…')
          : state.waits.length === 0
            ? h('div', { style: hint }, '还没有等待。让 agent 在需要等外部事件时调用 wait_create。')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                ...state.waits.map((wait) =>
                  h(
                    'div',
                    { key: wait.id, style: waitItem },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                      h('strong', null, statusText(wait.status)),
                      h('span', { style: hint }, wait.kindLabel || wait.kind),
                      wait.status === 'active' && remaining(wait.remainingMs)
                        ? h('span', { style: hint }, '剩余 ' + remaining(wait.remainingMs))
                        : null,
                      wait.delivery ? h('span', { style: hint }, deliveryText(wait.delivery)) : null,
                    ),
                    h('div', { style: mono }, wait.target || ''),
                    wait.note ? h('div', { style: hint }, wait.note) : null,
                    h(
                      'div',
                      { style: { ...hint, display: 'flex', gap: 12, flexWrap: 'wrap' } },
                      h('span', null, '创建：' + formatTime(wait.createdAt)),
                      wait.firedAt ? h('span', null, '触发：' + formatTime(wait.firedAt)) : null,
                      wait.deliveryError ? h('span', null, '错误：' + wait.deliveryError) : null,
                    ),
                    wait.status === 'active'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: smallButton,
                            disabled: state.cancelling === wait.id,
                            onClick: () => cancel(wait.id),
                          },
                          state.cancelling === wait.id ? '取消中…' : '取消等待',
                        )
                      : null,
                  ),
                ),
              ),
        h(
          'div',
          { style: hint },
          '设置保存在 DSH_HOME/data/durable-wait-settings.json，等待状态保存在 DSH_HOME/data/durable-wait.json。',
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'durable-wait',
              order: 44,
              label: () => '守候',
            },
            Panel,
          ),
        )
      },
    }
  },
})
