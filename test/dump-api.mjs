import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const res = await fetch('http://127.0.0.1:3425/v1/magpie/quotas?all=1')
const body = await res.json()
const data = body.data || []
console.log('顶层字段：', Object.keys(body).join(', '))

const byProvider = new Map()
for (const entry of data) {
  const id = entry.provider
  const rec = byProvider.get(id) || { kind: new Set(), plans: new Set(), keys: new Set(), winKeys: new Set(), n: 0, sample: null }
  rec.n += 1
  rec.kind.add(entry.kind)
  if (entry.plan) rec.plans.add(entry.plan)
  for (const k of Object.keys(entry)) rec.keys.add(k)
  for (const w of entry.windows || []) for (const k of Object.keys(w)) rec.winKeys.add(k)
  if (!rec.sample) rec.sample = { provider: id, name: entry.name, kind: entry.kind, plan: entry.plan, windows: (entry.windows || []).slice(0, 2) }
  byProvider.set(id, rec)
}

for (const [id, rec] of byProvider) {
  console.log(`\n=== ${id}  账号 ${rec.n}  kind=[${[...rec.kind].join(',')}]  plans=[${[...rec.plans].join('|')}]`)
  console.log('  条目字段：', [...rec.keys].join(', '))
  console.log('  窗口字段：', [...rec.winKeys].join(', '))
  console.log('  样本：', JSON.stringify(rec.sample).slice(0, 600))
}
