/**
 * magpie 插件：积分总览（宿主侧）
 *
 * 页面沙盒（magpie.panels）只能读 usage:summary 与 providers:list，且 CSP 是
 * connect-src 'none'，拿不到「每个账号还剩多少额度」。所以由插件宿主（Bun，本文件）
 * 读额度数据、算出供应商级聚合，再原子写入 panel/live.js；面板用
 * <script src="live.js?v=…"> 取回（沙盒允许加载自己的脚本文件，不允许 fetch）。
 *
 * 数据来源（两个都读，接口优先）：
 *   1. magpie 自己的实时额度接口 http://127.0.0.1:<port>/v1/magpie/quotas?all=1
 *      —— 新鲜，带 remaining 百分比、holds.tokens（令牌额度）、余额文案。
 *      ZCode 的令牌额度只在这里，quotas.json 缓存里根本没有它。
 *   2. ~/.config/magpie/quotas.json —— magpie 的缓存，接口拿不到时兜底。
 *
 * 为什么供应商会「新加了却不显示」——两个原因，这里都处理掉：
 *
 * 1. 额度形态不止「积分」一种。各家 auth.usage 的 windows 里可能是
 *    limit/amount（数量窗口）、只有 balance（预付费钱包）、只有百分比、
 *    或者只有一句 display 文案。旧版只留 credits 形态的窗口，
 *    其余整条供应商被丢掉，于是余额型 / 百分比型 / 文案型 / 读失败的供应商
 *    永远不出现。现在四种形态都归一化上报，供应商本身永远不丢。
 *
 * 2. 供应商清单不能只看额度数据。刚在 magpie 里加上的供应商（或刚装了插件
 *    的、额度还没读到的），数据里根本没有条目，插件就完全不知道它存在。
 *    所以这里再把 magpie 自己的供应商注册表合并进来：
 *      - plugin-providers.json：插件声明的供应商（name / signedIn / accounts）
 *      - providers.json：用户自己加的供应商
 *    注册了但还没有额度的供应商会以「待读取」的形式显示，而不是消失。
 *
 * 注意：magpie 的插件宿主会把本模块**导出的每一个函数**都当成插件入口调用一遍
 * （servers() 收集所有函数导出），所以这个文件只能有 default 导出；
 * 纯逻辑都放在 core.mjs 里，它不是入口文件。
 */

import { writeFile, rename, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSnapshot, loadRegistry, readJsonFile, entriesFromApi, entriesFromCache, SNAPSHOT_VERSION } from './core.mjs'

const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'panel')
const LIVE_FILE = join(PANEL_DIR, 'live.js')
const POLL_MS = 8000
const API_TIMEOUT_MS = 8000

let configDir = ''
let apiUrl = 'http://127.0.0.1:3425/v1/magpie/quotas?all=1'
let timer = null
let lastSignature = ''
let latest = null

/**
 * magpie 偶尔会留下一个没退干净的旧插件宿主进程，它和新进程一起往 live.js 写，
 * 于是旧代码会把新代码的快照盖掉。live.js 里带着快照版本号，
 * 谁版本新谁写，旧版本不写。
 */
async function writtenVersion() {
  try {
    const text = await readFile(LIVE_FILE, 'utf8')
    const match = /"v":(\d+)/.exec(text)
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

/** magpie 自己的接口端口在 gateway.json 里（默认 3425） */
async function resolveApiUrl() {
  const gateway = await readJsonFile('gateway.json', null, configDir)
  const addr = typeof gateway?.addr === 'string' ? gateway.addr : ''
  const port = addr.includes(':') ? Number(addr.split(':').pop()) : 0
  if (port > 0) return `http://${addr}/v1/magpie/quotas?all=1`
  return 'http://127.0.0.1:3425/v1/magpie/quotas?all=1'
}

/** 实时额度接口：magpie 自己算好的 auth.usage 结果 */
async function fetchApiEntries() {
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(API_TIMEOUT_MS) })
    if (!res.ok) return null
    const body = await res.json()
    const data = Array.isArray(body?.data) ? body.data : null
    if (!data) return null
    const entries = entriesFromApi(data)
    return entries.length ? entries : null
  } catch (err) {
    // 接口不可用（magpie 没开、端口变了）时退回缓存
    return null
  }
}

async function publish() {
  let entries = await fetchApiEntries()
  let source = 'api'

  if (!entries) {
    source = 'cache'
    const raw = await readJsonFile('quotas.json', null, configDir)
    if (!raw) return
    entries = entriesFromCache(raw)
    if (!entries.length) return
  }

  const registry = await loadRegistry(configDir)
  const snapshot = buildSnapshot(entries, registry, Date.now())
  const signature = JSON.stringify(snapshot)
  latest = snapshot
  if (signature === lastSignature) return

  if ((await writtenVersion()) > SNAPSHOT_VERSION) return

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

/**
 * magpie 的配置目录。宿主给的 input.directory 通常就是它，但以「哪里有
 * quotas.json」为准更稳：读不到就退回到 ~/.config/magpie。
 */
function resolveConfigDir(input) {
  const home = process.env.MAGPIE_HOME || process.env.HOME || process.env.USERPROFILE || ''
  const fallback = home ? join(home, '.config', 'magpie') : ''
  const candidates = [input?.directory, input?.worktree, fallback].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'quotas.json'))) return dir
  }
  return candidates[0] || fallback
}

/**
 * 只提供一个工具钩子：面板要的实时快照靠本模块的轮询产生，而这个模块只要被
 * 载入宿主就会跑起来。没有工具时 magpie 会把本插件当成「没有登录方式的供应商
 * 插件」，插件列表里多出一行提示；给出工具后它被认作「面板 + 工具」，不再误判。
 * 这个工具本身也有用：agent 可以直接问当前还有多少额度、哪些快到期。
 */
export default async function quotaGlance(input) {
  configDir = resolveConfigDir(input)
  apiUrl = await resolveApiUrl()
  start()
  return {
    tool: {
      quota_snapshot: {
        description:
          '当前各供应商的额度快照：每个供应商下所有账号的额度总量、已用、剩余、消耗百分比（积分、令牌等按单位分开），3 天内到期的额度总量与到期时刻；余额型（预付费钱包）、百分比型、只有文案的供应商也在列表里，各自带上自己的口径。',
        args: { type: 'object', properties: {} },
        execute: async () => {
          if (!latest) return '还没有读到额度快照：magpie 的额度接口或 quotas.json 都还没给出数据，稍后再试。'
          return JSON.stringify(latest, null, 2)
        },
      },
    },
  }
}
