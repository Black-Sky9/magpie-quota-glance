import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const res = await fetch('http://127.0.0.1:3425/v1/magpie/quotas?all=1')
const body = await res.json()
const data = body.data || []

const q = JSON.parse(readFileSync(join(homedir(), '.config', 'magpie', 'quotas.json'), 'utf8'))
const cache = new Map()
for (const [key, entry] of Object.entries(q)) {
  const id = String(entry?.quota?.provider || key.split('/')[0])
  if (!cache.has(id)) cache.set(id, [])
  cache.get(id).push({ key, entry })
}

for (const id of ['codearts', 'autoclaw', 'zcode', 'minimax-code-global']) {
  const api = data.filter((e) => e.provider === id)
  const cached = cache.get(id) || []
  console.log(`\n########## ${id}  API ${api.length} 条 / 缓存 ${cached.length} 条 ##########`)
  const apiWindows = api.flatMap((e) => (e.windows || []).map((w) => `${w.name}|limit=${w.limit}|amount=${w.amount}|unit=${w.unit}|bal=${w.balance}|text=${w.text}|aside=${w.aside}`))
  const cacheWindows = cached.flatMap(({ entry }) => ((entry.quota?.windows) || []).map((w) => `${w.name}|limit=${w.limit}|amount=${w.amount}|unit=${w.unit}|bal=${w.balance}|text=${w.text}`))
  console.log('API 窗口样本：', [...new Set(apiWindows)].slice(0, 8).join('\n            '))
  console.log('缓存窗口样本：', [...new Set(cacheWindows)].slice(0, 8).join('\n            '))
  console.log('API 顶层字段样例：', JSON.stringify(Object.keys(api[0] || {})), 'balance=', JSON.stringify(api[0]?.balance))
}
