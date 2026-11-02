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
let latest = null

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

const BUCKET_DAYS = { d1: 1, d3: 3, d7: 7, d15: 15 }

/** 空的分档计数：1 天内 / 3 天内 / 7 天内 / 15 天内 / 15 天以上（合计 = 剩余积分） */
const emptyBuckets = () => ({ d1: 0, d3: 0, d7: 0, d15: 0, later: 0 })

/**
 * 把某个窗口的剩余积分按到期紧迫程度归到一档。
 * magpie 只给得出「最快作废的那批」的时刻（runsOutAt/laps）与周期重置时刻（resetsAt），
 * 剩下的积分没有更细的到期信息，因此归入「15 天以上」，保证各档之和恒等于剩余积分。
 */
function addToBuckets(buckets, window, now) {
  const remain = window.remain
  if (!(remain > 0)) return { expiring: 0, expiresAt: 0 }

  let at = 0
  let credits = remain
  if (window.lapsAt > now) {
    at = window.lapsAt
    credits = window.laps > 0 ? Math.min(window.laps, remain) : remain
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
      buckets: emptyBuckets(),
    }

    for (const w of windows) {
      account.limit += w.limit
      account.used += w.used
      account.remain += w.remain
      const lapse = addToBuckets(account.buckets, w, now)
      if (lapse.expiring) account.expiring += lapse.expiring
      if (lapse.expiresAt) account.expiresAt = account.expiresAt ? Math.min(account.expiresAt, lapse.expiresAt) : lapse.expiresAt
    }

    account.usedPct = account.limit > 0 ? (account.used / account.limit) * 100 : 0
    account.known = account.limit > 0
    if (account.readAt > latestReadAt) latestReadAt = account.readAt

    // 额度一个都读不到的账号（已退登、被删、401、无套餐）不进快照：否则供应商删掉了，
    // quotas.json 里的旧记录还会让它一直挂在面板上
    if (!account.known) continue

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
      const buckets = emptyBuckets()
      for (const a of provider.accounts) {
        if (a.known) sum.known += 1
        sum.limit += a.limit
        sum.used += a.used
        sum.remain += a.remain
        sum.expiring += a.expiring
        if (a.expiresAt) sum.expiresAt = sum.expiresAt ? Math.min(sum.expiresAt, a.expiresAt) : a.expiresAt
        addBuckets(buckets, a.buckets)
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
        buckets,
        items: provider.accounts,
      }
    })
    .filter((p) => p.accounts > 0)
    .sort((a, b) => b.limit - a.limit || a.name.localeCompare(b.name))

  const total = {
    providers: list.length,
    accounts: 0,
    known: 0,
    limit: 0,
    used: 0,
    remain: 0,
    expiring: 0,
    expiresAt: 0,
    buckets: emptyBuckets(),
  }
  for (const p of list) {
    addBuckets(total.buckets, p.buckets)
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
  latest = snapshot
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
 * 只提供一个工具钩子：面板要的实时快照靠本模块的轮询产生，而这个模块只要被
 * 载入宿主就会跑起来。没有工具时 magpie 会把本插件当成「没有登录方式的供应商
 * 插件」，插件列表里多出一行提示；给出工具后它被认作「面板 + 工具」，不再误判。
 * 这个工具本身也有用：agent 可以直接问当前还有多少积分、哪些快到期。
 */
export default async function quotaGlance(input) {
  configDir = resolveConfigDir(input)
  start()
  return {
    tool: {
      quota_snapshot: {
        description:
          '当前各供应商的积分快照：每个供应商下所有账号的积分总量、已用积分与消耗百分比、剩余积分，以及 3 天内到期的积分总量与到期时刻。',
        args: { type: 'object', properties: {} },
        execute: async () => {
          if (!latest) return '还没有读到积分快照：magpie 的 quotas.json 尚未生成，稍后再试。'
          return JSON.stringify(latest, null, 2)
        },
      },
    },
  }
}
