/**
 * magpie 插件：积分总览（宿主侧）
 *
 * 页面沙盒（magpie.panels）只能读 usage:summary 与 providers:list，且 CSP 是
 * connect-src 'none'，拿不到「每个账号还剩多少积分」。而 magpie 自己已经把每次
 * auth.usage 的结果落在 `~/.config/magpie/quotas.json` 里（概览页卡片用的就是
 * 这份缓存）。所以由插件宿主（Bun，本文件）读这份文件、算出供应商级聚合，再原子
 * 写入 panel/live.js；面板用 <script src="live.js?v=…"> 取回（沙盒允许加载自己的
 * 脚本文件，不允许 fetch）。
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'panel')
const LIVE_FILE = join(PANEL_DIR, 'live.js')
const POLL_MS = 4000
const EXPIRING_DAYS = 3
const DAY = 86_400_000

let configDir = ''
let timer = null
let lastSignature = ''

const toNumber = (value) => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

const toTime = (value) => {
  if (!value) return 0
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : 0
}

/**
 * 账号在快照里只留一个短哈希：面板是给眼睛看的，不需要真实账号 ID，
 * 而 live.js 就躺在插件目录里，不该带可定位到具体账号的标识（如 iam::…）。
 */
const shortId = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 8)

/**
 * 一个账号计入统计的积分窗口。
 * quotas.json 的 windows 与 spans 按下标对应：spans[i].aside（或 window.aside）
 * 只是总额的拆分（CodeArts 的「基础积分包」「赠送积分包」），不能重复计入。
 */
function creditWindowsOf(entry) {
  const quota = entry?.quota ?? {}
  const spans = Array.isArray(entry?.spans) ? entry.spans : []
  const windows = Array.isArray(quota.windows) ? quota.windows : []
  const out = []

  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i]
    if (!w || typeof w !== 'object') continue
    if (w.aside || spans[i]?.aside) continue
    if ((w.unit || 'credits') !== 'credits') continue

    const limit = toNumber(w.limit)
    if (!(limit > 0)) continue

    // amount 是已用积分的绝对值，used 是百分比；只有百分比时按 limit 折算
    const used = Math.min(Math.max(toNumber(w.amount ?? (toNumber(w.used) / 100) * limit), 0), limit)
    out.push({
      name: String(w.name ?? ''),
      limit,
      used,
      remain: limit - used,
      lapsAt: toTime(w.runsOutAt),
      laps: Math.max(0, toNumber(w.runsOut)),
      resetsAt: toTime(w.resetsAt),
    })
  }

  return out
}

/** 该窗口在 N 天内失效的积分；runsOutAt 是积分批次真正作废的时刻，resetsAt 是周期重置。 */
function lapsingWithin(window, now, days) {
  const horizon = now + days * DAY
  if (window.lapsAt > now && window.lapsAt <= horizon) {
    return { credits: window.laps > 0 ? Math.min(window.laps, window.remain) : window.remain, at: window.lapsAt }
  }
  if (window.resetsAt > now && window.resetsAt <= horizon) {
    return { credits: window.remain, at: window.resetsAt }
  }
  return null
}

function buildSnapshot(raw, now) {
  const providers = new Map()
  let latestReadAt = 0

  for (const [key, entry] of Object.entries(raw ?? {})) {
    const quota = entry?.quota
    if (!quota || typeof quota !== 'object') continue

    const id = String(quota.provider || String(key).split('/')[0] || '')
    if (!id) continue

    const windows = creditWindowsOf(entry)
    const account = {
      key: shortId(key),
      user: String(quota.user || ''),
      plan: String(quota.plan || ''),
      readAt: toTime(quota.readAt || entry?.at),
      limit: 0,
      used: 0,
      remain: 0,
      expiring: 0,
      expiresAt: 0,
      windows,
    }

    for (const w of windows) {
      account.limit += w.limit
      account.used += w.used
      account.remain += w.remain
      const lapse = lapsingWithin(w, now, EXPIRING_DAYS)
      if (lapse) {
        account.expiring += lapse.credits
        account.expiresAt = account.expiresAt ? Math.min(account.expiresAt, lapse.at) : lapse.at
      }
    }

    account.usedPct = account.limit > 0 ? (account.used / account.limit) * 100 : 0
    account.known = account.limit > 0
    if (account.readAt > latestReadAt) latestReadAt = account.readAt

    let provider = providers.get(id)
    if (!provider) {
      provider = { id, name: String(quota.name || id), accounts: [] }
      providers.set(id, provider)
    }
    provider.accounts.push(account)
  }

  const list = [...providers.values()]
    .map((provider) => {
      const sum = { limit: 0, used: 0, remain: 0, expiring: 0, expiresAt: 0, known: 0 }
      for (const a of provider.accounts) {
        if (a.known) sum.known += 1
        sum.limit += a.limit
        sum.used += a.used
        sum.remain += a.remain
        sum.expiring += a.expiring
        if (a.expiresAt) sum.expiresAt = sum.expiresAt ? Math.min(sum.expiresAt, a.expiresAt) : a.expiresAt
      }
      const plans = [...new Set(provider.accounts.map((a) => a.plan).filter(Boolean))]
      provider.accounts.sort((a, b) => b.used - a.used || b.limit - a.limit)
      return {
        id: provider.id,
        name: provider.name,
        plans,
        accounts: provider.accounts.length,
        known: sum.known,
        limit: sum.limit,
        used: sum.used,
        remain: sum.remain,
        expiring: sum.expiring,
        expiresAt: sum.expiresAt,
        usedPct: sum.limit > 0 ? (sum.used / sum.limit) * 100 : 0,
        items: provider.accounts,
      }
    })
    .filter((p) => p.accounts > 0)
    .sort((a, b) => b.limit - a.limit || a.name.localeCompare(b.name))

  const total = { providers: list.length, accounts: 0, known: 0, limit: 0, used: 0, remain: 0, expiring: 0, expiresAt: 0 }
  for (const p of list) {
    total.accounts += p.accounts
    total.known += p.known
    total.limit += p.limit
    total.used += p.used
    total.remain += p.remain
    total.expiring += p.expiring
    if (p.expiresAt) total.expiresAt = total.expiresAt ? Math.min(total.expiresAt, p.expiresAt) : p.expiresAt
  }
  total.usedPct = total.limit > 0 ? (total.used / total.limit) * 100 : 0

  return { at: latestReadAt || now, days: EXPIRING_DAYS, total, providers: list }
}

async function publish() {
  let raw
  try {
    raw = JSON.parse(await readFile(join(configDir, 'quotas.json'), 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error(`quota-glance: quotas.json: ${err?.message || err}`)
    return
  }

  const snapshot = buildSnapshot(raw, Date.now())
  const signature = JSON.stringify(snapshot)
  if (signature === lastSignature) return

  const body = `self.__magpieQuota && self.__magpieQuota(${signature});\n`
  await mkdir(PANEL_DIR, { recursive: true })
  await writeFile(`${LIVE_FILE}.tmp`, body, 'utf8')
  await rename(`${LIVE_FILE}.tmp`, LIVE_FILE)
  lastSignature = signature
}

function start() {
  if (timer) return
  const run = () => {
    publish().catch((err) => console.error(`quota-glance: ${err?.message || err}`))
  }
  run()
  timer = setInterval(run, POLL_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

function resolveConfigDir(input) {
  const given = input?.directory || input?.worktree
  if (given) return given
  const home = process.env.MAGPIE_HOME || process.env.HOME || process.env.USERPROFILE || ''
  return join(home, '.config', 'magpie')
}

/**
 * 宿主只加载带钩子的插件，所以这里留两个不改任何东西的钩子：
 * config 让 magpie 启动时就载入本模块，chat.headers 保持一个空实现。
 */
export default async function quotaGlance(input) {
  configDir = resolveConfigDir(input)
  start()
  return {
    config: async () => {},
    'chat.headers': async () => {},
  }
}
