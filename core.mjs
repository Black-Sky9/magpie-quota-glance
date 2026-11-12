/**
 * magpie-quota-glance 的纯逻辑：把 magpie 的额度数据归一化成面板用的快照。
 *
 * 这个文件不作为插件入口加载（入口只有 index.mjs），所以可以自由导出函数，
 * 供自测脚本直接调用。
 *
 * 数据有两个来源，都归一化成同一种「账号条目」：
 *   - magpie 自己的实时额度接口 /v1/magpie/quotas?all=1（主源：新鲜，
 *     带 remaining 百分比、holds.tokens、余额文案；ZCode 的令牌额度只在这里）
 *   - ~/.config/magpie/quotas.json（magpie 的缓存；接口拿不到时兜底，
 *     它还带着 aside 标记，能指出哪些窗口是同一笔额度的拆分）
 *
 * 额度口径一共四种，任何一家供应商给什么都能显示：
 *   amount   —— 有 limit（>0）：按「数量 + 单位」计的额度（积分 credits / 令牌 tokens / 积分 / 点 …）
 *   percent  —— 只有百分比：窗口报 used（已用百分比）或 remaining（剩余百分比）
 *   balance  —— 只有余额：预付费钱包，钱包里剩多少
 *   text     —— 只有一句文案（例如「余额查询失败：…」），原样显示
 *
 * 关键约束：**不同单位不相加**。积分和令牌是两种计数，混在一起的总分没有意义，
 * 所以数量口径按「单位 + 窗口名」分组（同一个供应商的 GLM-5.3 与 GLM-5.3-Flash
 * 是两份额度，不该并成一份），余额与百分比也带单位。
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 面板标出的「快到期」窗口：3 天 */
export const EXPIRING_DAYS = 3

/** 快照结构版本 */
export const SNAPSHOT_VERSION = 4

const DAY = 86_400_000

const toNumber = (value) => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

const toTime = (value) => {
  if (!value) return 0
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : 0
}

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

const asText = (value) => (typeof value === 'string' ? value : '')

/**
 * 账号在快照里只留一个短哈希：面板是给眼睛看的，不需要真实账号 ID，
 * 而 live.js 就躺在插件目录里，不该带可定位到具体账号的标识（例如云平台的 IAM 账号 ID）。
 */
export const shortId = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 8)

const BUCKET_DAYS = { d1: 1, d3: 3, d7: 7, d15: 15 }

/** 单位的中文名：面板上写「积分总量」还是「令牌总量」 */
const UNIT_LABELS = {
  credits: '积分',
  credit: '积分',
  tokens: '令牌',
  token: '令牌',
  points: '点数',
  point: '点数',
}

/**
 * 同义单位归一：credits 与「积分」是一回事，不归一的话面板上会出现
 * 两张都叫「积分总量」的卡。令牌同理。
 */
const CANONICAL_UNITS = {
  credits: 'credits',
  credit: 'credits',
  积分: 'credits',
  tokens: 'tokens',
  token: 'tokens',
  令牌: 'tokens',
  points: 'points',
  point: 'points',
  点: 'points',
}

export function canonicalUnit(unit) {
  const text = asText(unit).trim()
  if (!text) return ''
  return CANONICAL_UNITS[text.toLowerCase()] || CANONICAL_UNITS[text] || text
}

export function unitLabel(unit) {
  const text = canonicalUnit(unit)
  if (!text) return '额度'
  return UNIT_LABELS[text.toLowerCase()] || text
}

/** 这个单位是不是「令牌」——令牌和积分不能混着加 */
export const isTokenUnit = (unit) => /token/i.test(asText(unit))

/** 窗口名里带了通用说法时，不必再写进标题（「总积分」就叫积分） */
const GENERIC_NAME = /积分|点数|余额|额度|用量|消费|消耗|credit|point|balance|quota|token/i

/** 数量口径的分组标题：单位 + 窗口名（窗口名有信息量时才带） */
export function groupLabel(unit, name) {
  const base = unitLabel(unit)
  const text = asText(name).trim()
  if (!text) return base
  if (GENERIC_NAME.test(text)) return base
  return `${base}·${text}`
}

/**
 * 形如「5185.52 credits」「$0.00」「10,836 积分」「500 点 · Agent 1660 点 可用」
 * 「1,200,000 tokens」的余额文案，抽出数值与单位。
 * 抽不出来（整句都是说明文字）时返回 null，由调用方当文案保留。
 */
export function parseQuantity(text) {
  const source = asText(text).trim()
  if (!source) return null
  const match = /^(?:([-$¥€£]))?\s*([\d][\d.,]*)\s*([^\s\d].*)?$/.exec(source)
  if (!match) return null
  const symbol = match[1] || ''
  const amount = Number(match[2].replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  let unit = (match[3] || '').trim()
  // 「500 点 · Agent 1660 点 可用」只取第一个单位，后面的说明不进单位
  const cut = unit.split(/[·:：,，;；]/)[0].trim()
  if (cut) unit = cut
  if (!unit) unit = symbol
  else if (symbol && !unit.startsWith(symbol)) unit = `${symbol}${unit}`
  // 单位过长说明这一句是说明文字而不是「数值 + 单位」
  if (unit.length > 12) return null
  return { amount: Math.max(0, amount), unit }
}

/**
 * 从窗口的展示文案里找出单位：magpie 有时不给 unit 字段，
 * 只在 display 末尾写「671 / 24,072 积分」。
 */
const KNOWN_UNITS = /^(积分|点数|点|元|余额|额度|令牌|次数|次|credits?|tokens?|points?|usd)$/i

function unitFromDisplay(display) {
  const source = asText(display)
  // 「671 / 24,072 积分」这种：单位跟在「已用 / 总量」后面
  const pair = /[\d.,]+\s*\/\s*[\d.,]+\s*([^\d\s/.,：:·|()（）]+)/.exec(source)
  if (pair) {
    const unit = pair[1].trim()
    if (KNOWN_UNITS.test(unit)) return unit
  }
  const match = /([\d.,]+)\s*([^\d\s/.,：:·|()（）]+)\s*$/.exec(source)
  if (!match) return ''
  const unit = match[2].trim()
  if (!KNOWN_UNITS.test(unit)) return ''
  return unit
}

/** 一眼是「报错 / 说明」而不是读数的文案（例如「余额查询失败：接口超时」） */
const MESSAGE_HINTS = ['失败', '错误', '超时', '异常', '不可用', '未开通', 'error', 'failed', 'timeout', 'timed out', 'denied', 'expired', 'undefined']

export function looksLikeMessage(text) {
  const source = asText(text)
  if (!source) return false
  if (/[:：]/.test(source)) return true
  if (source.length > 28) return true
  const lower = source.toLowerCase()
  return MESSAGE_HINTS.some((hint) => lower.includes(hint))
}

/** 空的分档计数：1 天内 / 3 天内 / 7 天内 / 15 天内 / 15 天以上（合计 = 剩余额度） */
const emptyBuckets = () => ({ d1: 0, d3: 0, d7: 0, d15: 0, later: 0 })

/** 窗口的字段归一：缓存和接口两种来源的字段名不一样，这里统一 */
function normWindow(w) {
  const display = asText(w?.display)
  const unit = canonicalUnit(asText(w?.unit) || unitFromDisplay(display))
  return {
    name: asText(w?.name),
    limit: w?.limit === undefined || w?.limit === null ? null : Math.max(0, toNumber(w.limit)),
    amount: w?.amount === undefined || w?.amount === null ? null : Math.max(0, toNumber(w.amount)),
    unit,
    used: w?.used === undefined || w?.used === null || w?.used === '' ? null : Math.max(0, toNumber(w.used)),
    remaining: w?.remaining === undefined || w?.remaining === null ? null : toNumber(w.remaining),
    balance: isNum(w?.balance) ? Math.max(0, w.balance) : null,
    text: w?.text === true,
    display,
    resetsAt: toTime(w?.resetsAt),
    runsOutAt: toTime(w?.runsOutAt),
    runsOut: Math.max(0, toNumber(w?.runsOut)),
    holds: w?.holds && typeof w.holds === 'object' ? w.holds : null,
    aside: false,
  }
}

/**
 * 找出「同一笔额度的拆分窗口」并标成 aside。
 *
 * magpie 的缓存里带 aside 标记（CodeArts 的「总积分」下面挂着
 * 「基础积分包」「赠送积分包」），但实时接口不带这个标记。
 * 这里用它们的和关系还原：同一单位下，若最大窗口的上限正好等于其余窗口上限之和，
 * 那么其余窗口就是它的拆分，只留最大的那个。
 * 两份额度不同的窗口（例如 ZCode 的 GLM-5.3 与 GLM-5.3-Flash）不满足这个关系，照样都留。
 */
function markSplits(windows) {
  const groups = new Map()
  for (const w of windows) {
    if (w.aside || !(w.limit > 0)) continue
    const list = groups.get(w.unit) || []
    list.push(w)
    groups.set(w.unit, list)
  }
  for (const list of groups.values()) {
    if (list.length < 3) continue
    const biggest = list.reduce((a, b) => (b.limit > a.limit ? b : a))
    const others = list.filter((w) => w !== biggest)
    const sum = others.reduce((s, w) => s + w.limit, 0)
    if (Math.abs(sum - biggest.limit) <= Math.max(1, biggest.limit * 0.005)) {
      for (const w of others) w.aside = true
    }
  }
}

/** 一个账号条目（两个来源归一后的形状） */
function makeEntry(raw) {
  return {
    key: raw.key,
    provider: asText(raw.provider),
    name: asText(raw.name),
    plan: asText(raw.plan),
    user: asText(raw.user),
    alias: asText(raw.alias),
    balance: asText(raw.balance),
    error: asText(raw.error),
    readAt: raw.readAt,
    windows: raw.windows,
  }
}

/** 从 magpie 的实时额度接口读来的条目 */
export function entriesFromApi(data) {
  const entries = []
  for (const item of Array.isArray(data) ? data : []) {
    const provider = asText(item?.provider)
    if (!provider) continue
    const user = asText(item?.user)
    const windows = (Array.isArray(item?.windows) ? item.windows : []).map(normWindow)
    entries.push(
      makeEntry({
        key: `${provider}/${user || entries.length}`,
        provider,
        name: asText(item?.name) || provider,
        plan: asText(item?.plan),
        user,
        alias: asText(item?.alias),
        balance: asText(item?.balance),
        error: asText(item?.error),
        readAt: toTime(item?.readAt),
        windows,
      }),
    )
  }
  applyProviderUnits(entries)
  for (const entry of entries) markSplits(entry.windows)
  return entries
}

/** 从 magpie 的缓存（quotas.json）读来的条目 */
export function entriesFromCache(raw) {
  const entries = []
  for (const [key, entry] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const quota = entry?.quota
    if (!quota || typeof quota !== 'object') continue
    const provider = asText(quota.provider) || asText(String(key).split('/')[0])
    if (!provider) continue
    const spans = Array.isArray(entry?.spans) ? entry.spans : []
    const rawWindows = Array.isArray(quota.windows) ? quota.windows : []
    const windows = rawWindows.map((w, i) => {
      const span = spans[i] && typeof spans[i] === 'object' ? spans[i] : {}
      const norm = normWindow(w)
      norm.aside = w?.aside === true || span.aside === true
      return norm
    })
    entries.push(
      makeEntry({
        key: String(key),
        provider,
        name: asText(quota.name) || provider,
        plan: asText(quota.plan),
        user: asText(quota.user),
        alias: '',
        balance: asText(quota.balance),
        error: '',
        readAt: toTime(quota.readAt || entry?.at),
        windows,
      }),
    )
  }
  applyProviderUnits(entries)
  return entries
}

/**
 * 供应商级别的单位推断：ZCode 的窗口不给 unit，但窗口里带 holds.tokens
 * （这一份额度是按令牌算的），同一个供应商的其它窗口也就都是令牌。
 */
function applyProviderUnits(entries) {
  const providers = new Map()
  for (const entry of entries) {
    const list = providers.get(entry.provider) || []
    list.push(entry)
    providers.set(entry.provider, list)
  }
  for (const list of providers.values()) {
    const tokenQuota = list.some((entry) => entry.windows.some((w) => w.holds && (isNum(w.holds.tokens) || (w.holds.routed && isNum(w.holds.routed.tokens)))))
    if (!tokenQuota) continue
    for (const entry of list) {
      for (const w of entry.windows) {
        if (!w.unit && w.limit > 0) w.unit = 'tokens'
      }
    }
  }
}

/**
 * 把某个窗口的剩余额度按到期紧迫程度归到一档。
 * magpie 只给得出「最快作废的那批」的时刻（runsOutAt/laps）与周期重置时刻（resetsAt），
 * 剩下的额度没有更细的到期信息，因此归入「15 天以上」，保证各档之和恒等于剩余额度。
 */
function addToBuckets(buckets, remain, window, now) {
  if (!(remain > 0)) return { expiring: 0, expiresAt: 0 }

  let at = 0
  let credits = remain
  if (window.runsOutAt > now) {
    at = window.runsOutAt
    credits = window.runsOut > 0 ? Math.min(window.runsOut, remain) : remain
  } else if (window.resetsAt > now) {
    at = window.resetsAt
  } else {
    buckets.later += remain
    return { expiring: 0, expiresAt: 0 }
  }

  const days = (at - now) / DAY
  const key = days <= 1 ? 'd1' : days <= 3 ? 'd3' : days <= 7 ? 'd7' : days <= 15 ? 'd15' : 'later'
  buckets[key] += credits
  if (remain > credits) buckets.later += remain - credits

  const near = key === 'd1' || key === 'd3'
  return { expiring: near ? credits : 0, expiresAt: near ? at : 0 }
}

function addBuckets(target, source) {
  for (const key of Object.keys(BUCKET_DAYS).concat('later')) target[key] += source?.[key] || 0
  return target
}

/** 一个账号（一个条目）的聚合 */
export function accountOf(entry, now) {
  const account = {
    key: shortId(entry.key),
    user: entry.user,
    alias: entry.alias,
    plan: entry.plan,
    readAt: entry.readAt,
    kind: 'none',
    known: false,
    units: [],
    percents: [],
    balances: [],
    notes: [],
  }

  // 数量口径按「单位 + 窗口名」分组：积分和令牌各算各的，同一供应商的
  // GLM-5.3 与 GLM-5.3-Flash 也是两份额度
  const unitMap = new Map()
  const unitOf = (w) => {
    const id = `${w.unit}${w.name}`
    let track = unitMap.get(id)
    if (!track) {
      track = {
        id,
        unit: w.unit,
        name: w.name,
        label: groupLabel(w.unit, w.name),
        limit: 0,
        used: 0,
        remain: 0,
        buckets: emptyBuckets(),
        expiring: 0,
        expiresAt: 0,
        windows: 0,
      }
      unitMap.set(id, track)
    }
    return track
  }

  for (const w of entry.windows) {
    // aside 只是总额的拆分：既不进合计，也不当额度线索展示
    if (w.aside) continue

    const limit = w.limit ?? 0
    if (limit > 0) {
      const used = Math.min(Math.max(w.amount ?? ((w.used ?? 0) / 100) * limit, 0), limit)
      const track = unitOf(w)
      track.limit += limit
      track.used += used
      track.remain += limit - used
      track.windows += 1
      const lapse = addToBuckets(track.buckets, limit - used, w, now)
      if (lapse.expiring) track.expiring += lapse.expiring
      if (lapse.expiresAt) track.expiresAt = track.expiresAt ? Math.min(track.expiresAt, lapse.expiresAt) : lapse.expiresAt
    } else if (w.balance !== null) {
      account.balances.push({ name: w.name, unit: w.unit, label: unitLabel(w.unit), amount: w.balance })
    } else if (w.text || (w.display && looksLikeMessage(w.display))) {
      // 报错、说明这类文案：原样显示，不当成百分比
      account.notes.push({ name: w.name, text: w.display })
    } else if (w.remaining !== null || w.used !== null) {
      const left = w.remaining !== null ? Math.max(0, w.remaining) : Math.max(0, 100 - (w.used ?? 0))
      account.percents.push({ name: w.name, unit: w.unit, used: 100 - left, left, resetsAt: w.resetsAt })
    } else if (w.display) {
      account.notes.push({ name: w.name, text: w.display })
    }
  }

  // 条目级的 balance 文案：能拆成「数值 + 单位」就作为余额口径，
  // 但若它正好等于某个数量窗口的剩余（MiniMax 的 "5185.52 credits" 就是 7000-1814.48），
  // 说明只是同一个数的另一种说法，不能重复展示
  const wallet = parseQuantity(entry.balance)
  const mirrors =
    wallet &&
    !account.balances.length &&
    [...unitMap.values()].some(
      (track) =>
        track.unit.toLowerCase() === wallet.unit.toLowerCase() &&
        Math.abs(wallet.amount - track.remain) <= Math.max(1, Math.abs(track.remain) * 0.005),
    )
  if (wallet && !account.balances.length && !mirrors) {
    account.balances.push({ name: '钱包', unit: wallet.unit, label: unitLabel(wallet.unit), amount: wallet.amount })
  } else if (!wallet && entry.balance && !account.notes.length) {
    account.notes.push({ name: '余额', text: entry.balance })
  }

  // 读取失败之类的话，原样显示
  if (entry.error && !account.notes.some((n) => n.text === entry.error)) {
    account.notes.push({ name: '读取', text: entry.error })
  }

  account.units = [...unitMap.values()].map((track) => ({
    ...track,
    usedPct: track.limit > 0 ? (track.used / track.limit) * 100 : 0,
  }))
  account.known = account.units.length > 0 || account.balances.length > 0 || account.percents.length > 0
  account.kind = accountKind(account)

  return account
}

/** 一个账号/供应商是哪种口径：积分 / 令牌 / 百分比 / 余额 / 文案 / 混合 / 未读 */
export function accountKind(item) {
  const kinds = new Set()
  for (const track of item.units || []) {
    if (track.limit > 0) kinds.add(isTokenUnit(track.unit) ? 'token' : 'credit')
  }
  if ((item.percents || []).length) kinds.add('percent')
  if ((item.balances || []).length) kinds.add('balance')
  if ((item.notes || []).length) kinds.add('text')
  if (!kinds.size) return 'none'
  if (kinds.size === 1) return [...kinds][0]
  return 'mixed'
}

export async function readJsonFile(name, fallback, dir) {
  try {
    return JSON.parse(await readFile(join(dir, name), 'utf8'))
  } catch (err) {
    // 文件被 magpie 正在重写时可能读到半截，轮询下一轮会自己好
    if (err?.code !== 'ENOENT') console.error(`quota-glance: ${name}: ${err?.message || err}`)
    return fallback
  }
}

/**
 * magpie 认识的供应商清单（不含额度）。
 * 注册表里「没登录且没有任何账号」的供应商不上报：它们只是插件提供的能力，用户还没用。
 */
export async function loadRegistry(dir) {
  const map = new Map()

  const pluginProviders = await readJsonFile('plugin-providers.json', [], dir)
  for (const item of Array.isArray(pluginProviders) ? pluginProviders : []) {
    const id = asText(item?.id)
    if (!id) continue
    const accounts = Array.isArray(item.accounts) ? item.accounts.length : 0
    map.set(id, {
      id,
      name: asText(item.name) || id,
      accounts,
      signedIn: item.signedIn === true,
      source: 'plugin',
    })
  }

  const userProviders = await readJsonFile('providers.json', {}, dir)
  const rows = Array.isArray(userProviders)
    ? userProviders
    : Array.isArray(userProviders?.providers)
      ? userProviders.providers
      : []
  for (const item of rows) {
    const id = asText(item?.id)
    if (!id) continue
    const prev = map.get(id)
    // 自己加的供应商，账号数看 accountProxies（键就是账号名）
    const proxies = item?.accountProxies && typeof item.accountProxies === 'object' ? Object.keys(item.accountProxies).length : 0
    const accounts = Array.isArray(item.accounts)
      ? item.accounts.length
      : proxies || Object.keys(item.accounts && typeof item.accounts === 'object' ? item.accounts : {}).length
    map.set(id, {
      id,
      name: asText(item.name) || prev?.name || id,
      accounts: Math.max(prev?.accounts ?? 0, accounts),
      // 自己加的供应商就是自己加的，不该因为它没被插件签入过就藏起来
      signedIn: true,
      source: prev ? 'both' : 'user',
    })
  }

  return map
}

/**
 * 造一份快照。
 *
 * @param entries   归一后的账号条目（entriesFromApi / entriesFromCache）
 * @param registry  loadRegistry 得到的 Map（id → 供应商信息）
 * @param now       当前时刻（毫秒）
 */
export function buildSnapshot(entries, registry, now) {
  const providers = new Map()

  const record = (id, name) => {
    let provider = providers.get(id)
    if (!provider) {
      provider = {
        id,
        name: name || id,
        plans: [],
        accounts: 0,
        known: 0,
        kind: 'none',
        units: [],
        percents: [],
        balances: [],
        notes: [],
        readAt: 0,
        registered: registry.has(id),
        items: [],
      }
      providers.set(id, provider)
    } else if (!provider.name && name) {
      provider.name = name
    }
    return provider
  }

  // 1) 额度：magpie 读到的每个账号
  let latestReadAt = 0
  for (const entry of entries || []) {
    const provider = record(entry.provider, entry.name)
    const account = accountOf(entry, now)

    provider.accounts += 1
    if (account.known) provider.known += 1
    if (account.plan && !provider.plans.includes(account.plan)) provider.plans.push(account.plan)
    if (account.readAt > provider.readAt) provider.readAt = account.readAt
    if (account.readAt > latestReadAt) latestReadAt = account.readAt

    for (const track of account.units) {
      let bucket = provider.units.find((u) => u.id === track.id)
      if (!bucket) {
        bucket = { ...track, limit: 0, used: 0, remain: 0, expiring: 0, expiresAt: 0, buckets: emptyBuckets(), accounts: 0 }
        provider.units.push(bucket)
      }
      bucket.limit += track.limit
      bucket.used += track.used
      bucket.remain += track.remain
      bucket.accounts += 1
      bucket.windows += track.windows
      bucket.expiring += track.expiring
      if (track.expiresAt) bucket.expiresAt = bucket.expiresAt ? Math.min(bucket.expiresAt, track.expiresAt) : track.expiresAt
      addBuckets(bucket.buckets, track.buckets)
    }

    // 百分比口径：同一个单位 + 窗口名，取最紧的一档
    for (const percent of account.percents) {
      let bucket = provider.percents.find((p) => p.unit === percent.unit && p.name === percent.name)
      if (!bucket) {
        bucket = { unit: percent.unit, label: unitLabel(percent.unit), name: percent.name, used: percent.used, left: percent.left, resetsAt: percent.resetsAt, accounts: 0 }
        provider.percents.push(bucket)
      }
      bucket.accounts += 1
      if (percent.left < bucket.left) {
        bucket.left = percent.left
        bucket.used = percent.used
        bucket.resetsAt = percent.resetsAt
      }
    }

    // 余额口径：按单位加总
    for (const bal of account.balances) {
      let bucket = provider.balances.find((b) => b.unit === bal.unit)
      if (!bucket) {
        bucket = { unit: bal.unit, label: unitLabel(bal.unit), amount: 0, accounts: 0 }
        provider.balances.push(bucket)
      }
      bucket.amount += bal.amount
      bucket.accounts += 1
    }

    for (const note of account.notes) {
      if (!provider.notes.some((n) => n.text === note.text)) provider.notes.push(note)
    }

    provider.items.push(account)
  }

  // 2) 供应商注册表：新加的供应商即使还没有额度也要出现（这里不覆盖 1) 的名字）
  for (const [id, entry] of registry) {
    const provider = providers.get(id)
    if (!provider) {
      if (!entry.signedIn && entry.accounts === 0) continue
      const fresh = record(id, entry.name)
      fresh.accounts = Math.max(fresh.accounts, entry.accounts)
      fresh.pending = true
      continue
    }
    if (!provider.accounts) provider.accounts = Math.max(provider.accounts, entry.accounts)
    if (!provider.items.length) provider.pending = true
  }

  const list = [...providers.values()]
    .map((provider) => {
      provider.kind = accountKind(provider)
      for (const track of provider.units) track.usedPct = track.limit > 0 ? (track.used / track.limit) * 100 : 0
      provider.percents.sort((a, b) => a.left - b.left)
      provider.percents = provider.percents.slice(0, 4)
      // 文案只留最能说明问题的那几条：报错/说明在前，纯读数在后
      provider.notes.sort((a, b) => Number(looksLikeMessage(b.text)) - Number(looksLikeMessage(a.text)))
      provider.notes = provider.notes.slice(0, 3)
      provider.accounts = Math.max(provider.accounts, provider.items.length)
      provider.items.sort((a, b) => b.used - a.used || a.user.localeCompare(b.user))
      return provider
    })
    .filter((provider) => provider.accounts > 0 || provider.pending)
    .sort((a, b) => (b.units[0]?.limit || 0) - (a.units[0]?.limit || 0) || b.accounts - a.accounts || a.name.localeCompare(b.name))

  const total = {
    providers: list.length,
    accounts: 0,
    known: 0,
    units: [],
    percents: [],
    balances: [],
    expiring: 0,
    expiresAt: 0,
    buckets: emptyBuckets(),
    counts: { credit: 0, token: 0, percent: 0, balance: 0, text: 0, none: 0, mixed: 0 },
  }
  for (const p of list) {
    total.accounts += p.accounts
    total.known += p.known
    total.counts[p.kind] = (total.counts[p.kind] || 0) + 1

    for (const track of p.units) {
      // 全站合计按单位分组：积分和令牌各一张卡；同一供应商的多个额度池
      // （ZCode 的 GLM-5.3 与 GLM-5.3-Flash）在这里并进同一个单位
      let bucket = total.units.find((u) => u.unit === track.unit)
      if (!bucket) {
        bucket = { ...track, id: track.unit, name: '', label: unitLabel(track.unit), limit: 0, used: 0, remain: 0, usedPct: 0, expiring: 0, expiresAt: 0, buckets: emptyBuckets(), providers: 0, accounts: 0 }
        total.units.push(bucket)
      }
      bucket.limit += track.limit
      bucket.used += track.used
      bucket.remain += track.remain
      bucket.providers += 1
      bucket.accounts += track.accounts
      bucket.expiring += track.expiring
      if (track.expiresAt) bucket.expiresAt = bucket.expiresAt ? Math.min(bucket.expiresAt, track.expiresAt) : track.expiresAt
      addBuckets(bucket.buckets, track.buckets)
    }

    for (const percent of p.percents) {
      let bucket = total.percents.find((x) => x.unit === percent.unit && x.name === percent.name)
      if (!bucket) {
        bucket = { unit: percent.unit, label: unitLabel(percent.unit), name: percent.name, used: percent.used, left: percent.left, resetsAt: percent.resetsAt, providers: 0, accounts: 0 }
        total.percents.push(bucket)
      }
      bucket.providers += 1
      bucket.accounts += percent.accounts
      if (percent.left < bucket.left) {
        bucket.left = percent.left
        bucket.used = percent.used
        bucket.resetsAt = percent.resetsAt
      }
    }

    for (const bal of p.balances) {
      let bucket = total.balances.find((b) => b.unit === bal.unit)
      if (!bucket) {
        bucket = { unit: bal.unit, label: unitLabel(bal.unit), amount: 0, providers: 0, accounts: 0 }
        total.balances.push(bucket)
      }
      bucket.amount += bal.amount
      bucket.providers += 1
      bucket.accounts += bal.accounts
    }
  }

  for (const track of total.units) track.usedPct = track.limit > 0 ? (track.used / track.limit) * 100 : 0
  total.percents.sort((a, b) => a.left - b.left)

  // 「3 天内到期」用额度最大的那个分组（通常是积分）
  const primary = total.units.slice().sort((a, b) => (isTokenUnit(a.unit) === isTokenUnit(b.unit) ? b.limit - a.limit : isTokenUnit(a.unit) ? 1 : -1))[0]
  if (primary) {
    total.expiring = primary.expiring
    total.expiresAt = primary.expiresAt
    total.buckets = primary.buckets
  }

  return { v: SNAPSHOT_VERSION, at: latestReadAt || now, days: EXPIRING_DAYS, total, providers: list }
}
