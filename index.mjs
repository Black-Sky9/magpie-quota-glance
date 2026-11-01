/**
 * magpie 插件：积分总览（宿主侧）
 *
 * 页面沙盒（magpie.panels）只能读 usage:summary 与 providers:list，且 CSP 是
 * connect-src 'none'，拿不到「每个账号还剩多少积分」。而 magpie 自己已经把每次
 * auth.usage 的结果落在 `~/.config/magpie/quotas.json` 里（概览页卡片用的就是
 * 这份缓存）。所以由插件宿主（Bun，本文件）读这份文件、算出供应商级聚合，再原子
 * 写入 panel/live.js；面板用 <script src="live.js?v=…"> 取回（沙盒允许加载自己的
 * 脚本文件，不允许 fetch）。
 *
 * 除了「limit + credits」，也识别各供应商常见的其他额度形态——余额
 * （balance / 剩余 N）、points/积分单位、display 里的「已用 / 上限」、
 * 只有百分比的窗口，以及 display 里的到期日期。
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

/** 解析失败返回 null，用来区分「没有这个字段」和「字段就是 0」 */
const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,，\s]/g, ''))
  return Number.isFinite(n) ? n : null
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

// 明显不是积分的单位（token、请求数、金额……）不并进积分合计。
// 其余未知单位（credits / credit / points / 积分 / 点数 …）按积分类处理。
const NON_CREDIT_UNIT = /(token|request|req\b|call|usd|dollar|\$|元|次|字符|char)/i

const isCreditUnit = (unit) => !NON_CREDIT_UNIT.test(String(unit ?? ''))

const NUM_RE = '([-+]?\\d[\\d,，]*(?:\\.\\d+)?)'

/** 只有展示文案且明显是读取失败/掉登录的窗口不算额度 */
const UNREADABLE_TEXT = /(失败|不可读|未登录|未登入|登录已过期|已过期|无套餐|未订阅|not\s*log(?:ged)?\s*in|unauthor|forbidden|error)/i

/**
 * 从供应商给的 display 文本里尽量抠出数字。display 是厂商自己的展示串，
 * 形态五花八门：'725 / 1600'、'0 / 500 credits'、'剩余 100 · 12-02 到期'、
 * '5000 credits'、'剩 100 · 30 天后作废'。
 */
function parseDisplay(text, now) {
  const out = { used: null, limit: null, remain: null, expiresAt: 0 }
  const s = String(text ?? '').replace(/\u00a0/g, ' ').trim()
  if (!s) return out

  // 已用 / 上限：'725 / 1600'、'0 / 500 credits'
  const pair = s.match(new RegExp(`${NUM_RE}\\s*\\/\\s*${NUM_RE}`))
  if (pair) {
    // '11/14 到期' 是日期，不是「已用 / 上限」
    const tail = s.slice(pair.index + pair[0].length, pair.index + pair[0].length + 6)
    if (!/^\s*(?:到期|作废|失效)/.test(tail)) {
      out.used = toNumberOrNull(pair[1])
      out.limit = toNumberOrNull(pair[2])
    }
  }

  // 剩余：'剩余 100'、'剩 -1'、'余额 0'
  const remain = s.match(new RegExp(`(?:剩余|剩|余额)\\s*${NUM_RE}`))
  if (remain) out.remain = toNumberOrNull(remain[1])

  // '<n> credits left'：也是剩余
  const left = s.match(new RegExp(`${NUM_RE}\\s*(?:credits?|积分|points?)\\s*left`, 'i'))
  if (left) out.remain = toNumberOrNull(left[1])

  // '5000 credits'、'0.00 credit'：只有余额
  if (out.limit === null && out.remain === null) {
    const bal = s.match(new RegExp(`${NUM_RE}\\s*(?:credits?|积分|points?)(?![\\w\\u4e00-\\u9fa5])`, 'i'))
    if (bal) out.remain = toNumberOrNull(bal[1])
  }

  out.expiresAt = parseExpiry(s, now)
  return out
}

/** display 里的到期/作废时刻：'12-02 到期'、'30 天后作废'、'2026-12-01 到期' */
function parseExpiry(text, now) {
  const s = String(text ?? '')
  if (!s) return 0

  const inDays = s.match(/(\d{1,3})\s*天(?:后|内)\s*(?:到期|作废|失效)/)
  if (inDays) return now + Number(inDays[1]) * DAY

  const full = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})\s*日?\s*(?:到期|作废|失效)/)
  if (full) {
    return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), 23, 59, 59, 999).getTime()
  }

  const short = s.match(/(\d{1,2})[-/月](\d{1,2})\s*日?\s*(?:到期|作废|失效)/)
  if (short) {
    const d = new Date(now)
    d.setMonth(Number(short[1]) - 1, Number(short[2]))
    d.setHours(23, 59, 59, 999)
    // 只写了月日：已经过去就当作明年
    if (d.getTime() < now - DAY) d.setFullYear(d.getFullYear() + 1)
    return d.getTime()
  }

  return 0
}

/**
 * 把一个额度窗口归一成四类：
 *   credit   有上限：limit / used / remain，可进总量与消耗
 *   balance  只有余额：remain（例如 AutoClaw、MagiCrew 的「积分余额」）
 *   percent  只有百分比：pct（例如 Cline / CommandCode 的周期用量）
 *   text     只有展示文案，不参与合计
 */
function readWindow(w, span, now) {
  const display = String(w.display ?? '')
  const name = String(w.name ?? '')
  const unit = String(w.unit ?? '').trim()
  const numeric = isCreditUnit(unit)
  const parsed = parseDisplay(display, now)

  const limitField = numeric ? toNumberOrNull(w.limit) : null
  const amountField = numeric ? toNumberOrNull(w.amount) : null
  const balanceField = numeric ? toNumberOrNull(w.balance) : null
  const usedPct = toNumberOrNull(w.used)
  const limit = limitField !== null ? limitField : parsed.limit

  const base = {
    name: name || display || '积分',
    display,
    unit,
    // runsOutAt 是批次真正作废的时刻；没有时退回 display 里的到期日期
    lapsAt: toTime(w.runsOutAt) || parsed.expiresAt,
    laps: Math.max(0, toNumber(w.runsOut)),
    resetsAt: toTime(w.resetsAt),
  }

  // 掉登录/查询失败的提示（used 往往是 0），没有任何真实数字，不能当成 0% 用量
  if (
    UNREADABLE_TEXT.test(display) &&
    limit === null && amountField === null && balanceField === null &&
    parsed.remain === null && parsed.used === null
  ) {
    return { ...base, kind: 'text', limit: 0, used: 0, remain: 0, pct: null }
  }

  if (limit !== null && limit > 0) {
    const used = amountField ?? parsed.used ?? (usedPct !== null ? (usedPct / 100) * limit : 0)
    const clamped = Math.min(Math.max(used, 0), limit)
    return { ...base, kind: 'credit', limit, used: clamped, remain: limit - clamped, pct: (clamped / limit) * 100 }
  }

  const remain = balanceField ?? parsed.remain
  if (remain !== null) {
    return { ...base, kind: 'balance', limit: 0, used: 0, remain: Math.max(0, remain), pct: null }
  }

  if (usedPct !== null) {
    return { ...base, kind: 'percent', limit: 0, used: 0, remain: 0, pct: Math.min(Math.max(usedPct, 0), 100) }
  }

  return { ...base, kind: 'text', limit: 0, used: 0, remain: 0, pct: null }
}

/**
 * 一个账号计入统计的积分窗口。
 * quotas.json 的 windows 与 spans 按下标对应：spans[i].aside（或 window.aside）
 * 只是总额的拆分（CodeArts 的「基础积分包」「赠送积分包」），不能重复计入；
 * 但如果整组都是 aside（Loomy、CatPaw 这类把每个池都标成拆分的），
 * 就说明没有总额窗口，应把它们当作真正的池。
 */
function creditWindowsOf(entry, now) {
  const quota = entry?.quota ?? {}
  const spans = Array.isArray(entry?.spans) ? entry.spans : []
  const windows = Array.isArray(quota.windows) ? quota.windows : []
  const all = []

  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i]
    if (!w || typeof w !== 'object') continue
    all.push({ aside: Boolean(w.aside || spans[i]?.aside), window: readWindow(w, spans[i], now) })
  }

  const primary = all.filter((item) => !item.aside)
  return (primary.length ? primary : all).map((item) => item.window)
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

    const windows = creditWindowsOf(entry, now)
    const usable = windows.filter((w) => !(w.kind === 'text' && UNREADABLE_TEXT.test(w.display)))
    const credit = usable.filter((w) => w.kind === 'credit')
    const balances = usable.filter((w) => w.kind === 'balance')
    const percents = usable.filter((w) => w.kind === 'percent')

    // 额度一个都读不到的账号（已退登、被删、401、无套餐）不进快照：否则供应商删掉了，
    // quotas.json 里的旧记录还会让它一直挂在面板上。只有说明性文案的窗口也不算额度。
    if (!credit.length && !balances.length && !percents.length) continue

    const account = {
      key: shortId(key),
      user: String(quota.user || ''),
      plan: String(quota.plan || ''),
      readAt: toTime(quota.readAt || entry?.at),
      limit: 0,
      used: 0,
      remain: 0,
      balance: 0,
      expiring: 0,
      expiresAt: 0,
      hasCredit: credit.length > 0,
      hasBalance: balances.length > 0,
      hasPercent: percents.length > 0,
      peakPct: 0,
      windows: usable,
    }

    for (const w of usable) {
      if (w.kind === 'credit') {
        account.limit += w.limit
        account.used += w.used
        account.remain += w.remain
      }
      if (w.kind === 'balance') account.balance += w.remain
      if (w.kind === 'percent' && w.pct > account.peakPct) account.peakPct = w.pct
      const lapse = lapsingWithin(w, now, EXPIRING_DAYS)
      if (lapse) {
        account.expiring += lapse.credits
        account.expiresAt = account.expiresAt ? Math.min(account.expiresAt, lapse.at) : lapse.at
      }
    }

    account.usedPct = account.limit > 0 ? (account.used / account.limit) * 100 : 0
    account.known = account.hasCredit
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
      const sum = {
        limit: 0, used: 0, remain: 0, balance: 0, expiring: 0, expiresAt: 0,
        known: 0, balanceOnly: 0, percentOnly: 0, peakPct: 0,
      }
      for (const a of provider.accounts) {
        if (a.known) sum.known += 1
        else if (a.hasBalance) sum.balanceOnly += 1
        else if (a.hasPercent) sum.percentOnly += 1
        sum.limit += a.limit
        sum.used += a.used
        sum.remain += a.remain
        sum.balance += a.balance
        sum.expiring += a.expiring
        if (a.peakPct > sum.peakPct) sum.peakPct = a.peakPct
        if (a.expiresAt) sum.expiresAt = sum.expiresAt ? Math.min(sum.expiresAt, a.expiresAt) : a.expiresAt
      }
      const plans = [...new Set(provider.accounts.map((a) => a.plan).filter(Boolean))]
      provider.accounts.sort((a, b) => b.used - a.used || b.limit - a.limit || b.balance - a.balance)
      return {
        id: provider.id,
        name: provider.name,
        plans,
        accounts: provider.accounts.length,
        known: sum.known,
        balanceOnly: sum.balanceOnly,
        percentOnly: sum.percentOnly,
        limit: sum.limit,
        used: sum.used,
        remain: sum.remain,
        balance: sum.balance,
        expiring: sum.expiring,
        expiresAt: sum.expiresAt,
        peakPct: sum.peakPct,
        usedPct: sum.limit > 0 ? (sum.used / sum.limit) * 100 : 0,
        items: provider.accounts,
      }
    })
    .filter((p) => p.accounts > 0)
    .sort((a, b) => b.limit - a.limit || b.balance - a.balance || a.name.localeCompare(b.name))

  const total = {
    providers: list.length, accounts: 0, known: 0, balanceOnly: 0, percentOnly: 0,
    limit: 0, used: 0, remain: 0, balance: 0, expiring: 0, expiresAt: 0, peakPct: 0,
  }
  for (const p of list) {
    total.accounts += p.accounts
    total.known += p.known
    total.balanceOnly += p.balanceOnly
    total.percentOnly += p.percentOnly
    total.limit += p.limit
    total.used += p.used
    total.remain += p.remain
    total.balance += p.balance
    total.expiring += p.expiring
    if (p.peakPct > total.peakPct) total.peakPct = p.peakPct
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
          '当前各供应商的积分快照：每个供应商下所有账号的积分总量、已用积分与消耗百分比、剩余积分、仅余额账号的余额，以及 3 天内到期的积分总量与到期时刻。',
        args: { type: 'object', properties: {} },
        execute: async () => {
          if (!latest) return '还没有读到积分快照：magpie 的 quotas.json 尚未生成，稍后再试。'
          return JSON.stringify(latest, null, 2)
        },
      },
    },
  }
}
