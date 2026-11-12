/**
 * magpie-quota-glance 的纯逻辑：把 magpie 的额度缓存归一化成面板用的快照。
 *
 * 这个文件不作为插件入口加载（入口只有 index.mjs），所以可以自由导出函数，
 * 供自测脚本直接调用。
 *
 * 额度口径一共四种，任何一家供应商给什么都能显示：
 *   amount   —— 有 limit（>0）：按「数量 + 单位」计的额度（积分 credits / 令牌 tokens / 积分 / 点 …）
 *   percent  —— 只有百分比：窗口报 used（已用百分比）或 remaining（剩余百分比）
 *   balance  —— 只有余额：预付费钱包，钱包里剩多少
 *   text     —— 只有一句文案（例如「余额查询失败：…」），原样显示
 *
 * 关键约束：**不同单位不相加**。积分和令牌是两种计数，混在一起的总分没有意义，
 * 所以金额口径按单位分组（unit），余额也按单位分组，百分比也带单位。
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 面板标出的「快到期」窗口：3 天 */
export const EXPIRING_DAYS = 3

/** 快照结构版本 */
export const SNAPSHOT_VERSION = 3

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

export function unitLabel(unit) {
  const text = asText(unit).trim()
  if (!text) return '额度'
  return UNIT_LABELS[text.toLowerCase()] || text
}

/** 这个单位是不是「令牌」——令牌和积分不能混着加 */
export const isTokenUnit = (unit) => /token/i.test(asText(unit))

/**
 * 形如「5185.52 credits」「$0.00」「10,836 积分」「500 点 · Agent 1660 点 可用」
 * 「1,000,000 tokens」的余额文案，抽出数值与单位。
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

/** 空的分档计数：1 天内 / 3 天内 / 7 天内 / 15 天内 / 15 天以上（合计 = 剩余积分） */
const emptyBuckets = () => ({ d1: 0, d3: 0, d7: 0, d15: 0, later: 0 })

/**
 * 把 quotas.json 的一个条目里的窗口归一化。
 *
 * spans[i].aside / windows[i].aside 表示「用掉它不影响账号可用」，只是总额的拆分
 * （「总积分」下面的「基础积分包」「赠送积分包」），所以不参与任何加总。
 */
export function windowsOf(entry) {
  const quota = entry?.quota && typeof entry.quota === 'object' ? entry.quota : {}
  const spans = Array.isArray(entry?.spans) ? entry.spans : []
  const raw = Array.isArray(quota.windows) ? quota.windows : []
  const out = []

  for (let i = 0; i < raw.length; i += 1) {
    const w = raw[i]
    if (!w || typeof w !== 'object') continue
    const span = spans[i] && typeof spans[i] === 'object' ? spans[i] : {}

    const hasLimit = w.limit !== undefined && w.limit !== null
    const limit = Math.max(0, toNumber(w.limit))
    const hasAmount = w.amount !== undefined && w.amount !== null
    const amount = Math.max(0, toNumber(w.amount))
    const balance = isNum(w.balance) ? Math.max(0, w.balance) : null
    const hasUsed = w.used !== undefined && w.used !== null && w.used !== '' && Number.isFinite(Number(w.used))
    const usedPct = hasUsed ? Math.max(0, toNumber(w.used)) : null
    // 有的插件报「还剩百分之多少」，有的报「已用百分之多少」，两种都收
    const remainingPct =
      w.remaining !== undefined && w.remaining !== null && Number.isFinite(Number(w.remaining)) && Number(w.remaining) >= 0 && Number(w.remaining) <= 100
        ? Number(w.remaining)
        : null
    const display = asText(w.display)
    const unit = asText(w.unit)

    let metric = 'none'
    if (hasLimit && limit > 0) metric = 'amount'
    else if (balance !== null) metric = 'balance'
    else if (remainingPct !== null) metric = 'percent'
    else if (usedPct !== null) metric = looksLikeMessage(display) ? 'text' : 'percent'
    else if (display) metric = 'text'

    // amount 是已用量的绝对值，used 是百分比；只有百分比时按 limit 折算
    const used = metric === 'amount' ? Math.min(Math.max(hasAmount ? amount : ((usedPct ?? 0) / 100) * limit, 0), limit) : 0
    // 百分比口径：剩余 = remaining（若给）或 100 − used
    const left = metric === 'percent' ? (remainingPct !== null ? remainingPct : Math.max(0, 100 - (usedPct ?? 0))) : 0

    out.push({
      name: asText(w.name),
      metric,
      aside: w.aside === true || span.aside === true,
      unit,
      limit: metric === 'amount' ? limit : 0,
      used,
      remain: metric === 'amount' ? limit - used : 0,
      balance,
      usedPct,
      remainingPct,
      left,
      display,
      resetsAt: toTime(w.resetsAt),
      runsOutAt: toTime(w.runsOutAt),
      runsOut: Math.max(0, toNumber(w.runsOut)),
    })
  }

  return out
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

/** 一个账号（quotas.json 的一个条目）的聚合 */
export function accountOf(key, entry, now) {
  const quota = entry?.quota && typeof entry.quota === 'object' ? entry.quota : {}
  const windows = windowsOf(entry)

  const account = {
    key: shortId(key),
    user: asText(quota.user),
    plan: asText(quota.plan),
    readAt: toTime(quota.readAt || entry?.at),
    kind: 'none',
    known: false,
    units: [],
    percents: [],
    balances: [],
    notes: [],
    balanceText: asText(quota.balance),
  }

  // 金额口径按单位分组：积分和令牌各算各的
  const unitMap = new Map()
  const unitOf = (unit) => {
    const key = asText(unit).trim()
    let track = unitMap.get(key)
    if (!track) {
      track = { unit: key, label: unitLabel(key), limit: 0, used: 0, remain: 0, buckets: emptyBuckets(), expiring: 0, expiresAt: 0, windows: 0 }
      unitMap.set(key, track)
    }
    return track
  }

  for (const w of windows) {
    // aside 只是总额的拆分：既不进合计，也不当额度线索展示
    if (w.aside) continue

    if (w.metric === 'amount') {
      const track = unitOf(w.unit)
      track.limit += w.limit
      track.used += w.used
      track.remain += w.remain
      track.windows += 1
      const lapse = addToBuckets(track.buckets, w.remain, w, now)
      if (lapse.expiring) track.expiring += lapse.expiring
      if (lapse.expiresAt) track.expiresAt = track.expiresAt ? Math.min(track.expiresAt, lapse.expiresAt) : lapse.expiresAt
    } else if (w.metric === 'balance') {
      account.balances.push({ name: w.name, unit: w.unit, amount: w.balance })
    } else if (w.metric === 'percent') {
      account.percents.push({ name: w.name, unit: w.unit, used: 100 - w.left, left: w.left, resetsAt: w.resetsAt })
    } else if (w.metric === 'text') {
      account.notes.push({ name: w.name, text: w.display })
    }
  }

  // 条目级的 balance 文案：能拆成「数值 + 单位」就作为余额口径，
  // 但若它正好等于某个金额窗口的剩余（MiniMax 的 "5185.52 credits" 就是 7000-1814.48），
  // 说明只是同一个数的另一种说法，不能重复展示
  const wallet = parseQuantity(account.balanceText)
  const mirrors =
    wallet &&
    !account.balances.length &&
    [...unitMap.values()].some(
      (track) =>
        track.unit.toLowerCase() === wallet.unit.toLowerCase() &&
        Math.abs(wallet.amount - track.remain) <= Math.max(1, Math.abs(track.remain) * 0.005),
    )
  if (wallet && !account.balances.length && !mirrors) {
    account.balances.push({ name: '钱包', unit: wallet.unit, amount: wallet.amount })
  } else if (!wallet && account.balanceText && !account.notes.length) {
    account.notes.push({ name: '余额', text: account.balanceText })
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
    const accounts = Array.isArray(item.accounts)
      ? item.accounts.length
      : Object.keys(item.accounts && typeof item.accounts === 'object' ? item.accounts : {}).length
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
 * @param raw      quotas.json 的内容
 * @param registry loadRegistry 得到的 Map（id → 供应商信息）
 * @param now      当前时刻（毫秒）
 */
export function buildSnapshot(raw, registry, now) {
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

  // 1) 额度：quotas.json 里 magpie 已经读到的每个账号
  let latestReadAt = 0
  for (const [key, entry] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const quota = entry?.quota
    if (!quota || typeof quota !== 'object') continue

    const id = asText(quota.provider) || asText(String(key).split('/')[0])
    if (!id) continue

    const account = accountOf(key, entry, now)
    const provider = record(id, asText(quota.name))

    provider.accounts += 1
    if (account.known) provider.known += 1
    if (account.plan && !provider.plans.includes(account.plan)) provider.plans.push(account.plan)
    if (account.readAt > provider.readAt) provider.readAt = account.readAt
    if (account.readAt > latestReadAt) latestReadAt = account.readAt

    // 金额口径：按单位把各账号的窗口加总
    for (const track of account.units) {
      let bucket = provider.units.find((u) => u.unit === track.unit)
      if (!bucket) {
        bucket = { unit: track.unit, label: track.label, limit: 0, used: 0, remain: 0, usedPct: 0, accounts: 0, windows: 0, buckets: emptyBuckets(), expiring: 0, expiresAt: 0 }
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
    for (const pct of account.percents) {
      let bucket = provider.percents.find((p) => p.unit === pct.unit && p.name === pct.name)
      if (!bucket) {
        bucket = { unit: pct.unit, label: unitLabel(pct.unit), name: pct.name, used: pct.used, left: pct.left, resetsAt: pct.resetsAt, accounts: 0 }
        provider.percents.push(bucket)
      }
      bucket.accounts += 1
      if (pct.left < bucket.left) {
        bucket.left = pct.left
        bucket.used = pct.used
        bucket.resetsAt = pct.resetsAt
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
      continue
    }
    if (!provider.accounts) provider.accounts = Math.max(provider.accounts, entry.accounts)
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
    .filter((provider) => provider.accounts > 0)
    .sort((a, b) => b.units[0]?.limit - a.units[0]?.limit || b.accounts - a.accounts || a.name.localeCompare(b.name))

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
      let bucket = total.units.find((u) => u.unit === track.unit)
      if (!bucket) {
        bucket = { unit: track.unit, label: track.label, limit: 0, used: 0, remain: 0, usedPct: 0, providers: 0, accounts: 0, buckets: emptyBuckets(), expiring: 0, expiresAt: 0 }
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

    for (const pct of p.percents) {
      let bucket = total.percents.find((x) => x.unit === pct.unit && x.name === pct.name)
      if (!bucket) {
        bucket = { unit: pct.unit, label: unitLabel(pct.unit), name: pct.name, used: pct.used, left: pct.left, resetsAt: pct.resetsAt, providers: 0, accounts: 0 }
        total.percents.push(bucket)
      }
      bucket.providers += 1
      bucket.accounts += pct.accounts
      if (pct.left < bucket.left) {
        bucket.left = pct.left
        bucket.used = pct.used
        bucket.resetsAt = pct.resetsAt
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

  // 「3 天内到期」用额度最大的那个单位（通常是积分）
  const primary = total.units.slice().sort((a, b) => b.limit - a.limit)[0]
  if (primary) {
    total.expiring = primary.expiring
    total.expiresAt = primary.expiresAt
    total.buckets = primary.buckets
  }

  return { v: SNAPSHOT_VERSION, at: latestReadAt || now, days: EXPIRING_DAYS, total, providers: list }
}
