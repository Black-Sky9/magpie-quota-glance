/**
 * 面板冒烟测试：在没有浏览器的环境里跑 panel/quota.js，
 * 用一个极小的 DOM 垫片把渲染结果 dump 成文本，确认每家供应商都被画出来。
 *
 *   node scratch/panel-smoke.mjs [snapshot.json]
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { buildSnapshot, loadRegistry } from '../core.mjs'

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.className = ''
    this._text = ''
    this.style = { setProperty() {}, width: '' }
    this.listeners = {}
    this.checked = false
    this.open = false
    this.type = ''
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(' ').filter(Boolean))
        for (const n of names) set.add(n)
        this.className = [...set].join(' ')
      },
      remove: (...names) => {
        const set = new Set(this.className.split(' ').filter(Boolean))
        for (const n of names) set.delete(n)
        this.className = [...set].join(' ')
      },
      contains: (name) => this.className.split(' ').includes(name),
    }
  }

  set textContent(value) {
    this.children = []
    this._text = String(value)
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('')
  }

  set innerHTML(value) {
    this._html = String(value)
  }

  get innerHTML() {
    return this._html || ''
  }

  get childNodes() {
    return this.children
  }

  append(...nodes) {
    for (const n of nodes) if (n) this.children.push(n)
  }

  appendChild(node) {
    this.children.push(node)
    return node
  }

  remove() {}

  addEventListener(name, fn) {
    ;(this.listeners[name] ||= []).push(fn)
  }
}

const root = new El('div')
const head = new El('head')

const document = {
  getElementById: (id) => (id === 'root' ? root : null),
  createElement: (tag) => new El(tag),
  head,
  body: new El('body'),
}

const magpie = {
  ready: Promise.resolve(),
  context: { provider: null },
  options: { get: async () => ({}), set: () => {} },
  onVisibility: () => {},
}

const sandbox = { document, magpie, window: { magpie }, self: null, setInterval: () => 0, clearTimeout, setTimeout, Date, Math, JSON, Number, String, Promise, console }
sandbox.self = sandbox
sandbox.globalThis = sandbox

const here = dirname(fileURLToPath(import.meta.url))
const panel = await readFile(join(here, '..', 'panel', 'quota.js'), 'utf8')
vm.runInNewContext(panel, sandbox, { filename: 'quota.js' })

let snapshot
const arg = process.argv[2]
if (arg && arg.endsWith('.json')) {
  snapshot = JSON.parse(await readFile(arg, 'utf8'))
} else {
  const dir = arg || join(homedir(), '.config', 'magpie')
  const raw = JSON.parse(await readFile(join(dir, 'quotas.json'), 'utf8'))
  snapshot = buildSnapshot(raw, await loadRegistry(dir), Date.now())
}

sandbox.self.__magpieQuota(snapshot)
await new Promise((resolve) => setTimeout(resolve, 30))

const line = (depth, text) => `${'  '.repeat(depth)}${text}`

function dump(node, depth = 0, out = []) {
  if (!node) return out
  const cls = node.className ? `.${String(node.className).split(' ').join('.')}` : ''
  const own = node._text ? ` «${node._text}»` : ''
  if (node.tagName !== 'DIV' || cls || own) out.push(line(depth, `${node.tagName.toLowerCase()}${cls}${own}`))
  for (const child of node.children) dump(child, node.tagName === 'DIV' && !cls ? depth : depth + 1, out)
  return out
}

function countProviders(node) {
  let n = 0
  if (String(node.className).split(' ').includes('provider')) n += 1
  for (const c of node.children) n += countProviders(c)
  return n
}

const out = dump(root)
console.log(out.join('\n'))
console.log(`\n渲染节点数 ${out.length}；供应商卡片 ${countProviders(root)} / 快照供应商 ${snapshot.providers.length}`)
