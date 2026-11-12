/**
 * magpie 插件：积分总览（宿主侧）
 *
 * 页面沙盒（magpie.panels）只能读 usage:summary 与 providers:list，且 CSP 是
 * connect-src 'none'，拿不到「每个账号还剩多少额度」。而 magpie 自己已经把每次
 * auth.usage 的结果落在 `~/.config/magpie/quotas.json` 里（概览页卡片用的就是这
 * 份缓存）。所以由插件宿主（Bun，本文件）读这份文件、算出供应商级聚合，再原子
 * 写入 panel/live.js；面板用 <script src="live.js?v=…"> 取回（沙盒允许加载自己的
 * 脚本文件，不允许 fetch）。
 *
 * 为什么供应商会「新加了却不显示」——两个原因，这里都处理掉：
 *
 * 1. 额度形态不止「积分」一种。各家 auth.usage 的 windows 里可能是
 *    limit/amount（计分窗口）、只有 balance（预付费钱包，没有总额）、只有
 *    used 百分比、或者只有一句 display 文案。旧版只留 credits 形态的窗口，
 *    其余整条供应商被丢掉，于是余额型 / 百分比型 / 文案型 / 读失败的供应商
 *    永远不出现。现在四种形态都归一化上报，供应商本身永远不丢。
 *
 * 2. 供应商清单不能只看 quotas.json。刚在 magpie 里加上的供应商（或刚装了插件
 *    的、额度还没读到的），quotas.json 里根本没有条目，插件就完全不知道它存在。
 *    所以这里再把 magpie 自己的供应商注册表合并进来：
 *      - plugin-providers.json：插件声明的供应商（name / signedIn / accounts）
 *      - providers.json：用户自己加的供应商
 *    注册了但还没有额度的供应商会以「待读取」的形式显示，而不是消失。
 *
 * 注意：magpie 的插件宿主会把本模块**导出的每一个函数**都当成插件入口调用一遍
 * （servers() 收集所有函数导出），所以这个文件只能有 default 导出；
 * 纯逻辑都放在 core.mjs 里，它不是入口文件。
 */

import { writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSnapshot, loadRegistry, readJsonFile } from './core.mjs'

const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'panel')
const LIVE_FILE = join(PANEL_DIR, 'live.js')
const POLL_MS = 4000

let configDir = ''
let timer = null
let lastSignature = ''
let latest = null

async function publish() {
  const raw = await readJsonFile('quotas.json', null, configDir)
  if (!raw) return

  const registry = await loadRegistry(configDir)
  const snapshot = buildSnapshot(raw, registry, Date.now())
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
  start()
  return {
    tool: {
      quota_snapshot: {
        description:
          '当前各供应商的额度快照：每个供应商下所有账号的积分总量、已用、剩余、消耗百分比，3 天内到期的积分总量与到期时刻；余额型（预付费钱包）、百分比型、只有文案的供应商也在列表里，各自带上自己的口径。',
        args: { type: 'object', properties: {} },
        execute: async () => {
          if (!latest) return '还没有读到额度快照：magpie 的 quotas.json 尚未生成，稍后再试。'
          return JSON.stringify(latest, null, 2)
        },
      },
    },
  }
}
