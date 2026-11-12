/**
 * 用旧版面板（浏览器/webview 缓存里的那份 quota.js）跑新快照，
 * 确认旧面板也能显示正确的数字（不是 0）。
 *
 *   node test/old-panel-check.mjs [旧面板路径]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import vm from 'node:vm'
import { buildSnapshot, loadRegistry, entriesFromApi } from '../core.mjs'

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.className = ''
    this._text = ''
    this.style = { setProperty() {}, width: '' }
    this.checked = false
    this.open = false
    this.type = ''
    this.classList = {
      add: (...n) => (this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...n])].join(' ')),
      remove: (...n) => (this.className = this.className.split(' ').filter((x) => !n.includes(x)).join(' ')),
      contains: (n) => this.className.split(' ').includes(n),
    }
  }

  set textContent(v) {
    this.children = []
    this._text = String(v)
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('')
  }

  set innerHTML(v) {
    this._html = String(v)
  }

  get innerHTML() {
    return this._html || ''
  }

  get childNodes() {
    return this.children
  }

  append(...n) {
    for (const x of n) if (x) this.children.push(x)
  }

  appendChild(n) {
    this.children.push(n)
    return n
  }

  remove() {}

  addEventListener() {}
}

const root = new El('div')
const sandbox = {
  document: { getElementById: (id) => (id === 'root' ? root : null), createElement: (t) => new El(t), head: new El('head'), body: new El('body') },
  magpie: { ready: Promise.resolve(), context: { provider: null }, options: { get: async () => ({}), set: () => {} }, onVisibility: () => {} },
  window: { magpie: {} },
  self: null,
  setInterval: () => 0,
  clearTimeout,
  setTimeout,
  Date,
  Math,
  JSON,
  Number,
  String,
  Promise,
  console,
}
sandbox.self = sandbox
sandbox.globalThis = sandbox

const oldPanel = process.argv[2] || 'F:/AI/magpie/plugins-src/magpie-quota-glance/panel/quota.js'
const code = await readFile(oldPanel, 'utf8')
vm.runInNewContext(code, sandbox, { filename: 'quota.js (old)' })

const dir = join(homedir(), '.config', 'magpie')
const res = await fetch('http://127.0.0.1:3425/v1/magpie/quotas?all=1')
const entries = entriesFromApi((await res.json()).data || [])
const snapshot = buildSnapshot(entries, await loadRegistry(dir), Date.now())

sandbox.self.__magpieQuota(snapshot)
await new Promise((r) => setTimeout(r, 30))

const text = root.textContent.replace(/\s+/g, ' ')
console.log(`旧面板：${oldPanel}`)
console.log('旧面板渲染：', text.slice(0, 260))

// 旧面板把 limit/used/remain 相加：任何一个是 undefined 都会变成 NaN，
// 而 NaN 会被 fmt() 变成 0 —— 这正是「全是 0」的成因
const bad = snapshot.providers.some((p) => ![p.limit, p.used, p.remain, p.usedPct, p.expiring, p.expiresAt].every((v) => typeof v === 'number'))
const zero = /积分总量0已用0/.test(text)
console.log(bad || zero ? '\n❌ 旧面板仍会显示 0' : '\n✅ 旧面板也能显示正确数字')
