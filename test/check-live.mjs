import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const live = join(homedir(), '.config', 'magpie', 'plugins', 'node_modules', 'magpie-quota-glance', 'panel', 'live.js')
const m = readFileSync(live, 'utf8').match(/__magpieQuota\((\{[\s\S]*\})\);/)
const d = JSON.parse(m[1])
console.log('units:', d.total.units.map((u) => `${u.label}(${u.unit}) ${u.limit}`).join(' | '))
console.log('labels are valid UTF-8:', d.total.units.every((u) => u.label === '积分' || u.label === '令牌'))

const hist = join(process.env.LOCALAPPDATA, 'magpie', 'inkstone-browser', 'Default', 'History')
try {
  const s = readFileSync(hist).toString('latin1')
  const urls = [...new Set((s.match(/https?:\/\/127\.0\.0\.1:[0-9]+[^\x00-\x1f"]{0,80}/g) || []).map((u) => u.replace(/[^\x21-\x7e/.:?=&%#-].*$/, '')))]
  console.log('app UI origins seen by the webview:')
  for (const u of urls.slice(0, 12)) console.log('  ', u)
} catch (err) {
  console.log('history read failed:', err.message)
}
