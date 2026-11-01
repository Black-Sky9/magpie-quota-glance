(() => {
  const REFRESH_MS = 3000
  const root = document.getElementById('root')

  let snapshot = null
  let visible = true
  let onlyProvider = ''
  let started = false
  let attempts = 0
  let renderedKey = ''
  const opened = new Set()

  const fmt = (n) => (Number.isFinite(n) ? n : 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 })

  const pct = (n) => `${(Math.round((Number.isFinite(n) ? n : 0) * 10) / 10).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`

  const clock = (ms) => {
    if (!ms) return ''
    const d = new Date(ms)
    const pad = (v) => String(v).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // 面板标题前的标记：矢量绘制，任何缩放下都清晰，也不额外请求图片
  const MARK =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round">' +
    '<circle cx="12" cy="12" r="8.25" stroke-width="2.6" stroke-opacity="0.2"/>' +
    '<path d="M12 3.75a8.25 8.25 0 1 1-5.8 14.1" stroke-width="2.6"/>' +
    '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>' +
    '</svg>'

  const mark = () => {
    const wrap = el('span', 'mark')
    wrap.innerHTML = MARK
    return wrap
  }

  const kv = (label, value, extra) => {
    const wrap = el('span', `kv${extra ? ` ${extra}` : ''}`)
    wrap.append(el('span', '', label), el('b', '', value))
    return wrap
  }

  function accountRow(item) {
    const row = el('div', `account${item.known ? '' : ' unknown'}`)
    const who = el('span', 'who', item.user || item.key)
    row.append(who)
    if (item.plan) row.append(el('span', 'tag', item.plan))

    if (!item.known) {
      row.append(el('span', 'grow'), el('span', 'val', '额度暂不可读'))
      return row
    }

    const val = el('span', 'val')
    val.append(el('span', '', '已用 '), el('b', '', fmt(item.used)), el('span', '', ` / ${fmt(item.limit)} · ${pct(item.usedPct)}`))
    row.append(el('span', 'grow'), val)

    const remain = el('span', 'val')
    remain.append(el('span', '', '剩余 '), el('b', '', fmt(item.remain)))
    row.append(remain)

    if (item.expiring > 0) {
      const exp = el('span', 'val exp')
      exp.append(el('b', '', fmt(item.expiring)), el('span', '', ` ${clock(item.expiresAt)} 到期`))
      row.append(exp)
    }

    return row
  }

  function providerCard(provider) {
    const card = el('div', 'provider')
    const top = el('div', 'top')
    top.append(el('span', 'name', provider.name))

    const meta = []
    meta.push(`${provider.accounts} 个账号`)
    if (provider.known < provider.accounts) meta.push(`${provider.accounts - provider.known} 个额度不可读`)
    if (provider.plans.length) meta.push(provider.plans.slice(0, 3).join(' / '))
    top.append(el('span', 'meta', meta.join(' · ')))
    top.append(el('span', 'grow'))

    if (provider.expiring > 0) {
      const chip = el('span', 'chip warn')
      chip.append(el('span', '', '3 天内到期'), el('b', '', fmt(provider.expiring)))
      top.append(chip)
    }
    card.append(top)

    const nums = el('div', 'nums')
    nums.append(kv('总量', fmt(provider.limit)))
    nums.append(kv('已用', fmt(provider.used)))
    nums.append(kv('消耗', pct(provider.usedPct), 'pct'))
    nums.append(kv('剩余', fmt(provider.remain)))
    if (provider.expiring > 0) nums.append(kv('到期', fmt(provider.expiring), 'exp'))
    card.append(nums)

    const bar = el('div', 'bar')
    const fill = el('i')
    fill.style.width = `${Math.min(100, Math.max(0, provider.usedPct))}%`
    bar.append(fill)
    card.append(bar)

    if (provider.items.length > 1) {
      const details = el('details')
      details.open = opened.has(provider.id)
      details.addEventListener('toggle', () => {
        if (details.open) opened.add(provider.id)
        else opened.delete(provider.id)
      })
      details.append(el('summary', '', `每个账号（${provider.items.length}）`))
      const list = el('div', 'accounts')
      for (const item of provider.items) list.append(accountRow(item))
      details.append(list)
      card.append(details)
    }

    return card
  }

  function render() {
    root.textContent = ''

    if (!snapshot) {
      if (!attempts) {
        root.append(el('p', 'hint', '正在读取积分…'))
      } else {
        root.append(el('p', 'hint error', '还没有收到积分数据：插件宿主还没跑起来，或本机没有 quotas.json。稍后会自动重试。'))
      }
      return
    }

    const data = snapshot
    const providers = onlyProvider ? data.providers.filter((p) => p.id === onlyProvider) : data.providers
    const scope = onlyProvider && providers.length === 1 ? providers[0] : data.total

    const head = el('div', 'head')
    head.append(mark(), el('h2', '', '积分总览'))
    const sub = []
    if (onlyProvider) {
      sub.push(`${providers.length ? providers[0].name : onlyProvider} · ${scope.accounts} 个账号`)
    } else {
      sub.push(`${data.total.providers} 个供应商 / ${data.total.accounts} 个账号`)
    }
    if (scope.known < scope.accounts) sub.push(`${scope.accounts - scope.known} 个额度不可读`)
    if (data.at) sub.push(`配额更新于 ${clock(data.at)}`)
    head.append(el('span', 'sub', sub.join(' · ')))
    head.append(el('span', 'spacer'))
    root.append(head)

    const totals = el('div', 'totals')
    const addTotal = (label, value, extra, warn) => {
      const box = el('div', `total${warn ? ' warn' : ''}`)
      box.append(el('div', 'k', label))
      const v = el('div', 'v', value)
      if (extra) v.append(el('small', '', extra))
      box.append(v)
      totals.append(box)
    }
    addTotal('积分总量', fmt(scope.limit))
    addTotal('已用', fmt(scope.used), `消耗 ${pct(scope.usedPct)}`)
    addTotal('剩余', fmt(scope.remain))
    addTotal(`${data.days} 天内到期`, fmt(scope.expiring), clock(scope.expiresAt), scope.expiring > 0)
    root.append(totals)

    if (!providers.length) {
      root.append(el('p', 'empty', onlyProvider ? '这个供应商还没有可读的积分额度。' : '没有可读的积分额度。'))
      return
    }

    const list = el('div', 'providers')
    for (const provider of providers) list.append(providerCard(provider))
    root.append(list)
  }

  function pull() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = `live.js?v=${Date.now()}`
      script.async = true
      script.onload = () => {
        script.remove()
        resolve()
      }
      script.onerror = () => {
        script.remove()
        reject(new Error('live.js'))
      }
      document.head.append(script)
    })
  }

  async function refresh() {
    attempts += 1
    try {
      await pull()
    } catch {
      if (!snapshot) render()
    }
  }

  self.__magpieQuota = (data) => {
    if (!data || typeof data !== 'object') return
    const key = JSON.stringify(data)
    snapshot = data
    attempts += 1
    if (key === renderedKey) return // 数据没变就不重画，免得展开的明细每分钟收起
    renderedKey = key
    render()
  }

  async function run() {
    if (started) return
    started = true

    try {
      await magpie.ready
    } catch {
      /* 主题没答也照常画 */
    }

    onlyProvider = magpie.context?.provider?.id || ''
    render()
    await refresh()

    setInterval(() => {
      if (visible) refresh()
    }, REFRESH_MS)

    magpie.onVisibility?.((next) => {
      visible = next !== false
      if (visible) refresh()
    })
  }

  render()

  if (window.magpie) {
    run()
  } else {
    const bridge = document.createElement('script')
    bridge.src = '/_magpie/bridge.js'
    bridge.onload = () => (window.magpie ? run() : render())
    bridge.onerror = () => render()
    document.head.append(bridge)
  }
})()
