/**
 * magpie-quota-glance 的纯逻辑：把 magpie 的额度缓存归一化成面板用的快照。
 *
 * 这个文件不作为插件入口加载（入口只有 index.mjs），所以可以自由导出函数，
 * 供自测脚本直接调用。
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 面板标出的「快到期」窗口：3 天 */
export const EXPIRING_DAYS = 3

/** 快照结构版本 */
export const SNAPSHOT_VERSION = 2

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

/**
 * 形如「5185.52 credits」「$0.00」「10,836 积分」「500 点 · Agent 1660 点 可用」的
 * 一句话余额（auth.usage 的 balance 字段就是这种文案），抽出数值与单位。
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
 * 形态判定顺序（先到先得，因为同一个窗口不会同时是两种）：
 *   credit  —— 有 limit > 0：这个窗口有总额，能算「已用 / 剩余 / 消耗%」
 *   balance —— 有数值 balance：预付费钱包，只有余额没有总额
 *   percent —— 有数值 used：百分比口径（used 是已用百分比，可能超过 100）
 *   text    —— 只有 display 文案（例如「余额查询失败：…」）
 *   none    —— 什么都没有
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
    const usedPct = w.used === undefined || w.used === null || w.used === '' ? null : Math.max(0, toNumber(w.used))
    const display = asText(w.display)

    let kind = 'none'
    if (hasLimit && limit > 0) kind = 'credit'
    else if (balance !== null) kind = 'balance'
    else if (usedPct !== null) kind = looksLikeMessage(display) ? 'text' : 'percent'
    else if (display) kind = 'text'

    // amount 是已用量的绝对值，used 是百分比；只有百分比时按 limit 折算
    const used = kind === 'credit' ? Math.min(Math.max(hasAmount ? amount : ((usedPct ?? 0) / 100) * limit, 0), limit) : 0

    out.push({
      name: asText(w.name),
      kind,
      aside: w.aside === true || span.aside === true,
      unit: asText(w.unit),
      limit: kind === 'credit' ? limit : 0,
      used,
      remain: kind === 'credit' ? limit - used : 0,
      balance,
      usedPct,
      display,
      resetsAt: toTime(w.resetsAt),
      runsOutAt: toTime(w.runsOutAt),
      runsOut: Math.max(0, toNumber(w.runsOut)),
    })
  }

  return out
}

/**
 * 把某个窗口的剩余积分按到期紧迫程度归到一档。
 * magpie 只给得出「最快作废的那批」的时刻（runsOutAt/laps）与周期重置时刻（resetsAt），
 * 剩下的积分没有更细的到期信息，因此归入「15 天以上」，保证各档之和恒等于剩余积分。
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

/** 余额按「单位」分桶：积分、点、$ 不能相加 */
function addBalance(list, unit, amount) {
  const found = list.find((item) => item.unit === unit)
  if (found) {
    found.amount += amount
    found.accounts += 1
  } else {
    list.push({ unit, amount, accounts: 1 })
  }
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
    credit: false,
    limit: 0,
    used: 0,
    remain: 0,
    usedPct: 0,
    expiring: 0,
    expiresAt: 0,
    buckets: emptyBuckets(),
    balances: [],
    percents: [],
    notes: [],
    balanceText: asText(quota.balance),
  }

  for (const w of windows) {
    // aside 只是总额的拆分：既不进合计，也不当额度线索展示
    if (w.aside) continue

    if (w.kind === 'credit') {
      account.credit = true
      account.limit += w.limit
      account.used += w.used
      account.remain += w.remain
      const lapse = addToBuckets(account.buckets, w.remain, w, now)
      if (lapse.expiring) account.expiring += lapse.expiring
      if (lapse.expiresAt) account.expiresAt = account.expiresAt ? Math.min(account.expiresAt, lapse.expiresAt) : lapse.expiresAt
    } else if (w.kind === 'balance') {
      account.balances.push({ name: w.name, unit: w.unit, amount: w.balance })
    } else if (w.kind === 'percent') {
      account.percents.push({ name: w.name, used: w.usedPct, left: Math.max(0, 100 - w.usedPct), resetsAt: w.resetsAt })
    } else if (w.kind === 'text') {
      account.notes.push({ name: w.name, text: w.display })
    }
  }

  // 条目级的 balance 文案：能拆成「数值 + 单位」就作为余额口径，
  // 但若它正好等于计分窗口的剩余（MiniMax 的 "5185.52 credits" 就是 7000-1814.48），
  // 说明只是同一个数的另一种说法，不能重复展示
  const wallet = parseQuantity(account.balanceText)
  // 容差取 1 或 0.5%：magpie 那边是四舍五入过的两位数，5185.52 / 4000.00 这种差 0.01
  // 是同一笔钱，不是另一笔余额
  const mirrorsCredit =
    wallet && account.credit && !account.balances.length && Math.abs(wallet.amount - account.remain) <= Math.max(1, Math.abs(account.remain) * 0.005)
  if (wallet && !account.balances.length && !mirrorsCredit) {
    account.balances.push({ name: '钱包', unit: wallet.unit, amount: wallet.amount })
  } else if (!wallet && account.balanceText && !account.notes.length) {
    account.notes.push({ name: '余额', text: account.balanceText })
  }

  account.known = account.credit || account.balances.length > 0 || account.percents.length > 0
  account.usedPct = account.limit > 0 ? (account.used / account.limit) * 100 : 0
  account.kind = account.credit
    ? 'credit'
    : account.balances.length
      ? 'balance'
      : account.percents.length
        ? 'percent'
        : account.notes.length
          ? 'text'
          : 'none'

  return account
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
        creditAccounts: 0,
        kind: 'none',
        limit: 0,
        used: 0,
        remain: 0,
        usedPct: 0,
        expiring: 0,
        expiresAt: 0,
        buckets: emptyBuckets(),
        balances: [],
        percents: [],
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
    if (account.credit) provider.creditAccounts += 1
    provider.limit += account.limit
    provider.used += account.used
    provider.remain += account.remain
    provider.expiring += account.expiring
    if (account.expiresAt) provider.expiresAt = provider.expiresAt ? Math.min(provider.expiresAt, account.expiresAt) : account.expiresAt
    addBuckets(provider.buckets, account.buckets)
    for (const bal of account.balances) addBalance(provider.balances, bal.unit, bal.amount)
    for (const pct of account.percents) provider.percents.push({ ...pct, key: account.key })
    for (const note of account.notes) {
      if (!provider.notes.some((n) => n.text === note.text)) provider.notes.push(note)
    }
    if (account.plan && !provider.plans.includes(account.plan)) provider.plans.push(account.plan)
    if (account.readAt > provider.readAt) provider.readAt = account.readAt
    if (account.readAt > latestReadAt) latestReadAt = account.readAt

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
      const kinds = new Set()
      if (provider.limit > 0) kinds.add('credit')
      if (provider.balances.length) kinds.add('balance')
      if (provider.percents.length) kinds.add('percent')
      if (provider.notes.length) kinds.add('text')
      provider.kind = kinds.size === 0 ? 'none' : kinds.size > 1 ? 'mixed' : [...kinds][0]
      provider.usedPct = provider.limit > 0 ? (provider.used / provider.limit) * 100 : 0
      provider.percents.sort((a, b) => a.left - b.left)
      provider.percents = provider.percents.slice(0, 4)
      // 文案只留最能说明问题的那几条：报错/说明在前，纯读数在后
      provider.notes.sort((a, b) => Number(looksLikeMessage(b.text)) - Number(looksLikeMessage(a.text)))
      provider.notes = provider.notes.slice(0, 3)
      provider.accounts = Math.max(provider.accounts, provider.items.length)
      provider.items.sort((a, b) => b.used - a.used || b.limit - a.limit || a.user.localeCompare(b.user))
      return provider
    })
    .filter((provider) => provider.accounts > 0)
    .sort((a, b) => b.limit - a.limit || b.accounts - a.accounts || a.name.localeCompare(b.name))

  const total = {
    providers: list.length,
    accounts: 0,
    known: 0,
    creditAccounts: 0,
    limit: 0,
    used: 0,
    remain: 0,
    usedPct: 0,
    expiring: 0,
    expiresAt: 0,
    buckets: emptyBuckets(),
    balances: [],
    counts: { credit: 0, balance: 0, percent: 0, text: 0, none: 0, mixed: 0 },
  }
  for (const p of list) {
    total.accounts += p.accounts
    total.known += p.known
    total.creditAccounts += p.creditAccounts
    total.limit += p.limit
    total.used += p.used
    total.remain += p.remain
    total.expiring += p.expiring
    if (p.expiresAt) total.expiresAt = total.expiresAt ? Math.min(total.expiresAt, p.expiresAt) : p.expiresAt
    addBuckets(total.buckets, p.buckets)
    total.counts[p.kind] = (total.counts[p.kind] || 0) + 1
    for (const bal of p.balances) {
      const found = total.balances.find((item) => item.unit === bal.unit)
      if (found) found.amount += bal.amount
      else total.balances.push({ unit: bal.unit, amount: bal.amount })
    }
  }
  total.usedPct = total.limit > 0 ? (total.used / total.limit) * 100 : 0

  return { v: SNAPSHOT_VERSION, at: latestReadAt || now, days: EXPIRING_DAYS, total, providers: list }
}
