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
  const excluded = new Set() // 被排除在合计之外的供应商 id，存在插件自己的 options 里
  let pickerOpen = false
  let showBuckets = false // 顶部「剩余按到期分布」默认收起
  let opts = {}
  let savedAt = 0
  let saveTimer = 0

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

  /** 只对纳入合计的供应商求和 */
  const sumOf = (list) => {
    const sum = {
      providers: list.length,
      accounts: 0,
      known: 0,
      limit: 0,
      used: 0,
      remain: 0,
      expiring: 0,
      expiresAt: 0,
      buckets: { d1: 0, d3: 0, d7: 0, d15: 0, later: 0 },
    }
    for (const p of list) {
      sum.accounts += p.accounts
      sum.known += p.known ?? p.accounts
      sum.limit += p.limit
      sum.used += p.used
      sum.remain += p.remain
      sum.expiring += p.expiring
      if (p.expiresAt) sum.expiresAt = sum.expiresAt ? Math.min(sum.expiresAt, p.expiresAt) : p.expiresAt
      for (const key of Object.keys(sum.buckets)) sum.buckets[key] += p.buckets?.[key] || 0
    }
    sum.usedPct = sum.limit > 0 ? (sum.used / sum.limit) * 100 : 0
    return sum
  }

  const BUCKET_LABELS = [
    ['d1', '1 天内'],
    ['d3', '3 天内'],
    ['d7', '7 天内'],
    ['d15', '15 天内'],
    ['later', '15 天以上'],
  ]

  /** 到期分档：越临期越靠左，五档之和 = 剩余积分 */
  function bucketChips(buckets, className) {
    const row = el('span', `buckets${className ? ` ${className}` : ''}`)
    row.title = '按到期时间划分的剩余积分，五档相加等于剩余积分'
    for (const [key, label] of BUCKET_LABELS) {
      const n = buckets?.[key] || 0
      const bk = el('span', `bk ${key}${n > 0 ? '' : ' zero'}`)
      // 每个色块的描边转速、闪光周期与相位都随机，看起来才不是整齐划一
      bk.style.setProperty('--spin', `${(6 + Math.random() * 5).toFixed(2)}s`)
      bk.style.setProperty('--sheen', `${(4.5 + Math.random() * 5).toFixed(2)}s`)
      bk.style.setProperty('--sheen-delay', `${(-Math.random() * 9).toFixed(2)}s`)
      bk.append(el('span', 'k', label), el('b', '', fmt(n)))
      row.append(bk)
    }
    return row
  }

  // options 每秒最多写一次，连续操作时合并成一次
  function saveOptions() {
    const next = { ...opts, excluded: [...excluded], showBuckets }
    opts = next
    const now = Date.now()
    clearTimeout(saveTimer)
    const wait = Math.max(0, 1000 - (now - savedAt))
    saveTimer = setTimeout(() => {
      savedAt = Date.now()
      try {
        magpie.options?.set?.(next)
      } catch {
        /* 写不进去也不影响本次显示 */
      }
    }, wait)
  }

  function toggleProvider(id, include) {
    if (include) excluded.delete(id)
    else excluded.add(id)
    renderedKey = ''
    saveOptions()
    render()
  }

  function toggleBuckets() {
    showBuckets = !showBuckets
    renderedKey = ''
    saveOptions()
    render()
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

  function providerCard(provider, allowExclude) {
    const card = el('div', 'provider')
    const top = el('div', 'top')
    top.append(el('span', 'name', provider.name))

    const meta = []
    meta.push(`${provider.accounts} 个账号`)
    if (provider.known < provider.accounts) meta.push(`${provider.accounts - provider.known} 个额度不可读`)
    if (provider.plans.length) meta.push(provider.plans.slice(0, 3).join(' / '))
    top.append(el('span', 'meta', meta.join(' · ')))
    top.append(el('span', 'grow'))

    // 到期分档：越临期越靠左；五档之和 = 该供应商的剩余积分
    if (provider.buckets) top.append(bucketChips(provider.buckets))

    if (allowExclude) {
      const drop = el('button', 'exclude', '排除')
      drop.type = 'button'
      drop.title = '把这个供应商从合计里去掉'
      drop.addEventListener('click', () => toggleProvider(provider.id, false))
      top.append(drop)
    }
    card.append(top)

    const nums = el('div', 'nums')
    nums.append(kv('总量', fmt(provider.limit)))
    nums.append(kv('已用', fmt(provider.used)))
    nums.append(kv('消耗', pct(provider.usedPct), 'pct'))
    nums.append(kv('剩余', fmt(provider.remain)))
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

  /** 供应商选择框：列出当前识别到的所有供应商，勾选决定是否纳入合计 */
  function pickerBox(providers) {
    const box = el('div', 'picker')
    const head = el('div', 'picker-head')
    head.append(el('span', 'label', '纳入合计的供应商'))
    head.append(el('span', 'grow'))

    const all = el('button', 'mini', '全选')
    all.type = 'button'
    all.addEventListener('click', () => {
      excluded.clear()
      renderedKey = ''
      saveExcluded()
      render()
    })

    const none = el('button', 'mini', '全不选')
    none.type = 'button'
    none.addEventListener('click', () => {
      for (const p of providers) excluded.add(p.id)
      renderedKey = ''
      saveExcluded()
      render()
    })

    head.append(all, none)
    box.append(head)

    for (const p of providers) {
      const row = el('label', 'picker-row')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !excluded.has(p.id)
      cb.addEventListener('change', () => toggleProvider(p.id, cb.checked))
      row.append(cb)
      row.append(el('span', 'pname', p.name))
      row.append(el('span', 'pmeta', `${p.accounts} 个账号 · 总量 ${fmt(p.limit)} · 已用 ${fmt(p.used)}`))
      box.append(row)
    }

    return box
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
    const all = onlyProvider ? data.providers.filter((p) => p.id === onlyProvider) : data.providers
    const providers = all.filter((p) => onlyProvider || !excluded.has(p.id))
    const scope = providers.length ? sumOf(providers) : sumOf([])

    const head = el('div', 'head')
    head.append(mark(), el('h2', '', '积分总览'))
    const sub = []
    if (onlyProvider) {
      sub.push(`${providers.length ? providers[0].name : onlyProvider} · ${scope.accounts} 个账号`)
    } else {
      sub.push(`${providers.length} 个供应商 / ${scope.accounts} 个账号`)
      if (excluded.size) sub.push(`已排除 ${excluded.size} 个`)
    }
    if (scope.known < scope.accounts) sub.push(`${scope.accounts - scope.known} 个额度不可读`)
    if (data.at) sub.push(`配额更新于 ${clock(data.at)}`)
    head.append(el('span', 'sub', sub.join(' · ')))
    head.append(el('span', 'spacer'))

    if (!onlyProvider && data.providers.length) {
      const dist = el('button', `pick${showBuckets ? ' on' : ''}`, '到期分布')
      dist.type = 'button'
      dist.title = showBuckets ? '收起顶部的到期分布' : '展开顶部的到期分布'
      dist.addEventListener('click', toggleBuckets)
      head.append(dist)

      const pick = el('button', `pick${pickerOpen ? ' on' : ''}`, '选择供应商')
      pick.type = 'button'
      pick.addEventListener('click', () => {
        pickerOpen = !pickerOpen
        render()
      })
      head.append(pick)
    }
    root.append(head)

    if (pickerOpen && !onlyProvider) root.append(pickerBox(data.providers))

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

    // 顶部全站分档默认收起，用标题栏的「到期分布」按钮展开
    if (showBuckets && !onlyProvider && scope.buckets) {
      const row = el('div', 'bucket-row')
      row.append(el('span', 'bucket-label', '剩余按到期分布'))
      row.append(bucketChips(scope.buckets))
      root.append(row)
    }

    if (!all.length) {
      root.append(el('p', 'empty', onlyProvider ? '这个供应商还没有可读的积分额度。' : '没有可读的积分额度。'))
      return
    }

    if (!providers.length) {
      root.append(el('p', 'empty', '所有供应商都被排除在合计之外，用右上角的「选择供应商」把它们放回来。'))
      return
    }

    const list = el('div', 'providers')
    for (const provider of providers) list.append(providerCard(provider, !onlyProvider))
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

    // 排除掉的供应商、是否展开顶部到期分布，都存在插件自己的 options 里
    try {
      const loaded = await magpie.options?.get?.()
      opts = loaded && typeof loaded === 'object' ? loaded : {}
      if (Array.isArray(opts.excluded)) {
        for (const id of opts.excluded) if (typeof id === 'string' && id) excluded.add(id)
      }
      showBuckets = opts.showBuckets === true
    } catch {
      /* 读不到就用默认值 */
    }

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
