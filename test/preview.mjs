import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { buildSnapshot, loadRegistry } from '../core.mjs'

const dir = process.argv[2] || join(homedir(), '.config', 'magpie')
const raw = JSON.parse(await readFile(join(dir, 'quotas.json'), 'utf8'))
const registry = await loadRegistry(dir)
const snap = buildSnapshot(raw, registry, Date.now())

const f = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0).toLocaleString('zh-CN')

console.log('registry 里的供应商：')
for (const [id, r] of registry) console.log(`  ${id.padEnd(24)} ${r.name.padEnd(26)} signedIn=${r.signedIn} accounts=${r.accounts} src=${r.source}`)

console.log('\n快照里的供应商（面板会逐个画出来）：')
for (const p of snap.providers) {
  const bits = [`kind=${p.kind}`, `accounts=${p.accounts}/${p.known}`, `plans=${p.plans.join('/') || '-'}`]
  if (p.limit > 0) bits.push(`总量=${f(p.limit)} 已用=${f(p.used)} 剩余=${f(p.remain)} 消耗=${f(p.usedPct)}%`)
  if (p.balances.length) bits.push(`余额=${p.balances.map((b) => `${f(b.amount)}${b.unit || ''}`).join('+')}`)
  if (p.percents.length) bits.push(`百分比=${p.percents.map((x) => `${x.name}:剩${f(x.left)}%`).join(',')}`)
  if (p.notes.length) bits.push(`notes=${p.notes.map((n) => n.text.slice(0, 24)).join(' | ')}`)
  bits.push(`readAt=${p.readAt ? new Date(p.readAt).toLocaleString('zh-CN') : '-'}`)
  console.log(`  ${p.name.padEnd(26)} ${bits.join('  ')}`)
}

console.log('\n合计：')
const t = snap.total
console.log(`  供应商 ${t.providers} / 账号 ${t.accounts}（已知额度 ${t.known}）`)
console.log(`  积分口径：总量 ${f(t.limit)} 已用 ${f(t.used)} 剩余 ${f(t.remain)} 消耗 ${f(t.usedPct)}%`)
console.log(`  3 天内到期 ${f(t.expiring)} ${t.expiresAt ? new Date(t.expiresAt).toLocaleString('zh-CN') : ''}`)
console.log(`  分档 ${JSON.stringify(t.buckets)}`)
console.log(`  非积分口径余额：${t.balances.map((b) => `${f(b.amount)}${b.unit || '(无单位)'}`).join('、') || '无'}`)
console.log(`  各形态供应商数：${JSON.stringify(t.counts)}`)
console.log(`\n快照字节数 ${JSON.stringify(snap).length}`)
