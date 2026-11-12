(() => {
  const REFRESH_MS = 3000
  const STALE_MS = 60 * 60 * 1000
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

  const CURRENCY = /^[-$¥€£]$/

  /** 单位的中文名（宿主给的是归一后的单位，credits 要显示成「积分」） */
  const unitText = (unit, label) => {
    if (CURRENCY.test(unit || '')) return unit
    return label || unit || ''
  }

  /** 数额 + 单位：「1,234 积分」「$0」「5185.5 credits」 */
  const money = (amount, unit, label) => {
    const value = fmt(amount)
    const u = unitText(unit, label)
    if (!u) return value
    return CURRENCY.test(unit) ? `${unit}${value}` : `${value} ${u}`
  }

  const short = (text, max = 60) => {
    const source = String(text ?? '')
    return source.length > max ? `${source.slice(0, max)}…` : source
  }

  const clock = (ms) => {
    if (!ms) return ''
    const d = new Date(ms)
    const pad = (v) => String(v).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /** 「12 分钟前」/「3 小时前」，超过两天就退回日期 */
  const freshness = (ms) => {
    if (!ms) return ''
    const age = Date.now() - ms
    if (age < 0) return clock(ms)
    const minutes = Math.round(age / 60000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.round(minutes / 60)
    if (hours < 48) return `${hours} 小时前`
    return clock(ms)
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

  const chip = (text, extra) => el('span', `chip${extra ? ` ${extra}` : ''}`, text)

  /**
   * 额度口径：积分、令牌、百分比、余额、文案，各家给什么都能显示。
   * 不同单位的数不相加，所以口径是按单位分的组。
   */
  const KIND_LABEL = {
    credit: '积分',
    token: '令牌',
    percent: '百分比',
    balance: '余额',
    text: '文案',
    mixed: '混合口径',
    none: '待读取',
  }

  const kindTag = (kind) => {
    if (!kind || kind === 'credit') return null
    const tag = el('span', `kind ${kind}`, KIND_LABEL[kind] || kind)
    tag.title =
      kind === 'token'
        ? '按令牌数量计的额度，不和积分混着加'
        : kind === 'balance'
          ? '预付费余额：只有还剩多少，没有总额'
          : kind === 'percent'
            ? '按百分比计量的额度'
            : kind === 'text'
              ? '供应商只给了一句文案（常见于读取失败）'
              : kind === 'none'
                ? '这个供应商还没有读到额度'
                : '同一个供应商下混着几种口径'
    return tag
  }

  const BUCKET_LABELS = [
    ['d1', '1 天内'],
    ['d3', '3 天内'],
    ['d7', '7 天内'],
    ['d15', '15 天内'],
    ['later', '15 天以上'],
  ]

  /** 到期分档：越临期越靠左，五档之和 = 剩余额度 */
  function bucketChips(buckets, className) {
    const row = el('span', `buckets${className ? ` ${className}` : ''}`)
    row.title = '按到期时间划分的剩余额度，五档相加等于剩余额度'
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

  /** 一个金额口径的一行数字：总量 / 已用 / 消耗 / 剩余 */
  function amountNums(track, days) {
    const nums = el('div', 'nums')
    nums.append(kv('总量', fmt(track.limit)))
    nums.append(kv('已用', fmt(track.used)))
    nums.append(kv('消耗', pct(track.usedPct), 'pct'))
    nums.append(kv('剩余', fmt(track.remain)))
    if (track.expiring > 0) {
      const exp = kv(`${days} 天内到期`, fmt(track.expiring), 'exp')
      exp.title = `${clock(track.expiresAt)} 到期`
      nums.append(exp)
    }
    return nums
  }

  function amountBar(track) {
    const bar = el('div', 'bar')
    const fill = el('i')
    fill.style.width = `${Math.min(100, Math.max(0, track.usedPct))}%`
    bar.append(fill)
    return bar
  }

  /** 一个账号（某个供应商下的一行） */
  function accountRow(item) {
    const row = el('div', `account${item.known ? '' : ' unknown'}`)
    row.append(el('span', 'who', item.user || item.key))
    if (item.plan) row.append(el('span', 'tag', item.plan))
    row.append(el('span', 'grow'))

    for (const track of item.units || []) {
      const used = el('span', 'val')
      used.append(el('span', '', `${track.label}已用 `), el('b', '', fmt(track.used)), el('span', '', ` / ${fmt(track.limit)} · ${pct(track.usedPct)}`))
      row.append(used)
      const remain = el('span', 'val')
      remain.append(el('span', '', '剩余 '), el('b', '', fmt(track.remain)))
      row.append(remain)
    }

    for (const bal of item.balances || []) {
      const val = el('span', 'val')
      val.append(el('span', '', '余额 '), el('b', '', money(bal.amount, bal.unit, bal.label)))
      row.append(val)
    }

    if (!(item.units || []).length && (item.percents || []).length) {
      const worst = item.percents[0]
      const val = el('span', 'val')
      val.append(el('span', '', `${worst.name ? `${worst.name} 剩 ` : '剩 '}`), el('b', '', pct(worst.left)))
      if (worst.resetsAt) val.append(el('span', '', ` · ${clock(worst.resetsAt)} 重置`))
      row.append(val)
    }

    if (!item.known) {
      const note = item.notes?.[0]
      if (note) {
        const val = el('span', 'val note-text', short(note.text, 48))
        val.title = note.text
        row.append(val)
      } else {
        row.append(el('span', 'val', '额度暂不可读'))
      }
    }

    return row
  }

  function providerCard(provider, allowExclude, days) {
    const card = el('div', `provider kind-${provider.kind || 'none'}`)
    const top = el('div', 'top')
    top.append(el('span', 'name', provider.name))
    const tag = kindTag(provider.kind)
    if (tag) top.append(tag)

    const meta = [`${provider.accounts} 个账号`]
    if (provider.known < provider.accounts) meta.push(`${provider.accounts - provider.known} 个额度不可读`)
    if (provider.plans.length) meta.push(provider.plans.slice(0, 3).join(' / '))
    top.append(el('span', 'meta', meta.join(' · ')))
    top.append(el('span', 'grow'))

    // 数据比整份快照旧得多的时候才提示，免得每张卡都挂着时间
    if (provider.readAt && provider.readAt < Date.now() - STALE_MS) {
      const stale = el('span', 'chip warn', `读取于 ${freshness(provider.readAt)}`)
      stale.title = `这个供应商的额度最后读取于 ${clock(provider.readAt)}`
      top.append(stale)
    }

    if (allowExclude) {
      const drop = el('button', 'exclude', '排除')
      drop.type = 'button'
      drop.title = '把这个供应商从合计里去掉'
      drop.addEventListener('click', () => toggleProvider(provider.id, false))
      top.append(drop)
    }
    card.append(top)

    // 金额口径：一个单位一组（积分一组、令牌一组，互不相加）
    for (const track of provider.units || []) {
      const group = el('div', 'unit')
      if (provider.units.length > 1 || track.label !== '积分') {
        const label = el('div', 'unit-label', track.label)
        group.append(label)
      }
      group.append(amountNums(track, days))
      group.append(amountBar(track))
      if (track.buckets) {
        const chips = bucketChips(track.buckets)
        chips.classList.add('inline')
        group.append(chips)
      }
      card.append(group)
    }

    // 百分比口径
    for (const percent of provider.percents || []) {
      const nums = el('div', 'nums')
      nums.append(kv(`剩余（${percent.label}${percent.name ? ` · ${percent.name}` : ''}）`, pct(percent.left), 'pct'))
      if (percent.resetsAt) nums.append(kv('重置', clock(percent.resetsAt)))
      card.append(nums)
    }

    // 余额口径：按单位分列
    for (const bal of provider.balances || []) {
      const nums = el('div', 'nums')
      nums.append(kv(`余额（${bal.label}${bal.accounts > 1 ? ` · ${bal.accounts} 个账号` : ''}）`, money(bal.amount, bal.unit, bal.label)))
      card.append(nums)
    }

    if (provider.notes?.length) {
      const notes = el('div', 'notes')
      for (const note of provider.notes) {
        const line = el('div', 'note', short(note.text, 120))
        line.title = note.text
        notes.append(line)
      }
      card.append(notes)
    } else if (!(provider.units || []).length && !(provider.percents || []).length && !(provider.balances || []).length) {
      // 供应商在，额度还没读到：说清楚下一步该做什么，而不是整张卡空着
      const notes = el('div', 'notes')
      notes.append(el('div', 'note', '额度还没读出来：在 magpie 里对它发一次请求，或等下一轮用量刷新。'))
      card.append(notes)
    }

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

  /** 选择框里的一行摘要：按供应商自己的口径说人话 */
  function summaryOf(provider) {
    const parts = [`${provider.accounts} 个账号`]
    for (const track of provider.units || []) parts.push(`${track.label} ${fmt(track.limit)} · 已用 ${fmt(track.used)}`)
    for (const bal of provider.balances || []) parts.push(`余额 ${money(bal.amount, bal.unit, bal.label)}`)
    for (const percent of provider.percents || []) parts.push(`${percent.label}剩 ${pct(percent.left)}`)
    if (!(provider.units || []).length && !(provider.balances || []).length && !(provider.percents || []).length) parts.push('额度未读')
    return parts.join(' · ')
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
      saveOptions()
      render()
    })

    const none = el('button', 'mini', '全不选')
    none.type = 'button'
    none.addEventListener('click', () => {
      for (const p of providers) excluded.add(p.id)
      renderedKey = ''
      saveOptions()
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
      const kind = kindTag(p.kind)
      if (kind) row.append(kind)
      row.append(el('span', 'pmeta', summaryOf(p)))
      box.append(row)
    }

    return box
  }

  /** 余额 / 百分比 / 文案这些不进合计的供应商，顶部留一句，免得以为被吞了 */
  function otherRow(scope, providers) {
    const counts = { text: 0, none: 0 }
    const items = []
    for (const bal of scope.balances || []) if (bal.amount > 0) items.push(chip(`余额 ${money(bal.amount, bal.unit, bal.label)}`))
    for (const percent of scope.percents || []) items.push(chip(`${percent.label}剩 ${pct(percent.left)}${percent.name ? `（${percent.name}）` : ''}`))
    for (const p of providers) {
      if (p.kind === 'text') counts.text += 1
      if (p.kind === 'none') counts.none += 1
    }
    if (counts.text) items.push(chip(`${counts.text} 个只有文案提示`))
    if (counts.none) items.push(chip(`${counts.none} 个额度未读`))
    if (!items.length) return null

    const row = el('div', 'note-row')
    row.append(el('span', 'note-label', '不计入合计'))
    for (const item of items) row.append(item)
    return row
  }

  /** 合计里「按单位分组」的数字卡片：积分一组、令牌一组 */
  function unitCards(total, days) {
    const cards = el('div', 'totals')
    const addCard = (label, value, extra, warn) => {
      const box = el('div', `total${warn ? ' warn' : ''}`)
      box.append(el('div', 'k', label))
      const v = el('div', 'v', value)
      if (extra) v.append(el('small', '', extra))
      box.append(v)
      cards.append(box)
    }

    for (const track of total.units || []) {
      addCard(`${track.label}总量`, fmt(track.limit), `已用 ${fmt(track.used)} · 消耗 ${pct(track.usedPct)}`)
    }
    for (const track of total.units || []) {
      if (track.expiring > 0) addCard(`${track.label} ${days} 天内到期`, fmt(track.expiring), clock(track.expiresAt), true)
    }
    return cards
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
    const other = providers.filter((p) => p.kind !== 'credit' && p.kind !== 'token').length

    // 合计按单位重新加总：积分和令牌各算各的
    const scope = { units: [], balances: [], percents: [], accounts: 0, known: 0, expiring: 0, expiresAt: 0 }
    for (const p of providers) {
      scope.accounts += p.accounts
      scope.known += p.known
      for (const track of p.units || []) {
        let bucket = scope.units.find((u) => u.unit === track.unit)
        if (!bucket) {
          // 全站合计按单位分组，标题只用单位名（供应商卡片里才带窗口名）
          const label = String(track.label || track.unit || '').split('·')[0]
          bucket = { unit: track.unit, label, limit: 0, used: 0, remain: 0, usedPct: 0, expiring: 0, expiresAt: 0, buckets: { d1: 0, d3: 0, d7: 0, d15: 0, later: 0 } }
          scope.units.push(bucket)
        }
        bucket.limit += track.limit
        bucket.used += track.used
        bucket.remain += track.remain
        bucket.expiring += track.expiring
        if (track.expiresAt) bucket.expiresAt = bucket.expiresAt ? Math.min(bucket.expiresAt, track.expiresAt) : track.expiresAt
        for (const key of Object.keys(bucket.buckets)) bucket.buckets[key] += track.buckets?.[key] || 0
      }
      for (const bal of p.balances || []) {
        let bucket = scope.balances.find((b) => b.unit === bal.unit)
        if (!bucket) {
          bucket = { unit: bal.unit, label: bal.label, amount: 0, accounts: 0 }
          scope.balances.push(bucket)
        }
        bucket.amount += bal.amount
        bucket.accounts += bal.accounts
      }
      for (const pct of p.percents || []) {
        let bucket = scope.percents.find((x) => x.unit === pct.unit && x.name === pct.name)
        if (!bucket) {
          bucket = { unit: pct.unit, label: pct.label, name: pct.name, left: pct.left, resetsAt: pct.resetsAt, accounts: 0 }
          scope.percents.push(bucket)
        }
        bucket.accounts += pct.accounts
        if (pct.left < bucket.left) {
          bucket.left = pct.left
          bucket.resetsAt = pct.resetsAt
        }
      }
    }
    for (const track of scope.units) track.usedPct = track.limit > 0 ? (track.used / track.limit) * 100 : 0
    // 「剩余按到期分布」用额度最大的非令牌分组（积分那一组）
    const primary = scope.units
      .slice()
      .sort((a, b) => (/token/i.test(String(a.unit)) === /token/i.test(String(b.unit)) ? b.limit - a.limit : /token/i.test(String(a.unit)) ? 1 : -1))[0]
    if (primary) {
      scope.expiring = primary.expiring
      scope.expiresAt = primary.expiresAt
      scope.buckets = primary.buckets
    }

    const head = el('div', 'head')
    head.append(mark(), el('h2', '', '积分总览'))
    const sub = []
    if (onlyProvider) {
      sub.push(`${providers.length ? providers[0].name : onlyProvider} · ${scope.accounts} 个账号`)
    } else {
      sub.push(`${providers.length} 个供应商 / ${scope.accounts} 个账号`)
      if (excluded.size) sub.push(`已排除 ${excluded.size} 个`)
    }
    if (other) sub.push(`${other} 个非金额口径`)
    if (scope.known < scope.accounts) sub.push(`${scope.accounts - scope.known} 个额度不可读`)
    if (data.at) sub.push(`配额更新于 ${freshness(data.at)}`)
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

    root.append(unitCards(scope, data.days))

    const others = otherRow(scope, providers)
    if (others) root.append(others)

    // 顶部全站分档默认收起，用标题栏的「到期分布」按钮展开
    if (showBuckets && !onlyProvider && scope.buckets) {
      const row = el('div', 'bucket-row')
      row.append(el('span', 'bucket-label', '剩余按到期分布'))
      row.append(bucketChips(scope.buckets))
      root.append(row)
    }

    if (!all.length) {
      root.append(el('p', 'empty', onlyProvider ? '这个供应商还没有可读的额度。' : '还没有识别到任何供应商：magpie 里先加一个，插件会在几秒内跟上。'))
      return
    }

    if (!providers.length) {
      root.append(el('p', 'empty', '所有供应商都被排除在合计之外，用右上角的「选择供应商」把它们放回来。'))
      return
    }

    const list = el('div', 'providers')
    for (const provider of providers) list.append(providerCard(provider, !onlyProvider, data.days))
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
