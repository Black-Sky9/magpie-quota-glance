import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { buildSnapshot, loadRegistry, entriesFromApi, entriesFromCache } from '../core.mjs'

const here = process.argv[2] ? '' : ''

const dir = process.env.MAGPIE_CONFIG || join(homedir(), '.config', 'magpie')
const registry = await loadRegistry(dir)

let entries
let source = 'cache'
if (process.env.QUOTA_SOURCE === 'api' || process.argv.includes('--api')) {
  const res = await fetch(`http://127.0.0.1:3425/v1/magpie/quotas?all=1`)
  const body = await res.json()
  entries = entriesFromApi(body.data || [])
  source = 'api'
} else {
  const raw = JSON.parse(await readFile(join(dir, 'quotas.json'), 'utf8'))
  entries = entriesFromCache(raw)
}

const snap = buildSnapshot(entries, registry, Date.now())
const f = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0).toLocaleString('zh-CN')

console.log(`数据来源：${source}  账号条目 ${entries.length}`)
console.log('\n快照里的供应商（面板会逐个画出来）：')
for (const p of snap.providers) {
  const bits = [`kind=${p.kind}`, `账号=${p.accounts}/${p.known}`, `plans=${p.plans.join('/') || '-'}`]
  for (const t of p.units) bits.push(`${t.label}：总量 ${f(t.limit)} 已用 ${f(t.used)} 剩余 ${f(t.remain)} 消耗 ${f(t.usedPct)}%`)
  for (const b of p.balances) bits.push(`余额 ${f(b.amount)}${b.unit}`)
  for (const x of p.percents) bits.push(`${x.label}${x.name} 剩 ${f(x.left)}%`)
  if (p.notes.length) bits.push(`notes=${p.notes.map((n) => n.text.slice(0, 24)).join(' | ')}`)
  console.log(`  ${p.name.padEnd(20)} ${bits.join('  ')}`)
}

console.log('\n合计（按单位分开，不混加）：')
const t = snap.total
console.log(`  供应商 ${t.providers} / 账号 ${t.accounts}（已知额度 ${t.known}）`)
for (const u of t.units) console.log(`  ${u.label}：总量 ${f(u.limit)} 已用 ${f(u.used)} 剩余 ${f(u.remain)} 消耗 ${f(u.usedPct)}%（${u.providers} 个供应商）`)
for (const b of t.balances) console.log(`  余额 ${f(b.amount)}${b.unit}`)
for (const x of t.percents) console.log(`  百分比 ${x.label}${x.name} 剩 ${f(x.left)}%`)
console.log(`  3 天内到期 ${f(t.expiring)} ${t.expiresAt ? new Date(t.expiresAt).toLocaleString('zh-CN') : ''}`)
console.log(`  各形态供应商数：${JSON.stringify(t.counts)}`)
console.log(`\n快照字节数 ${JSON.stringify(snap).length}`)
