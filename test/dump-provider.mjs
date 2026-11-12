import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const q = JSON.parse(readFileSync(join(homedir(), '.config', 'magpie', 'quotas.json'), 'utf8'))
const want = process.argv[2]
let shown = 0
for (const [key, entry] of Object.entries(q)) {
  const id = String(entry?.quota?.provider || key.split('/')[0])
  if (want && id !== want) continue
  if (want && shown >= 2) break
  shown += 1
  console.log('====', key, '====')
  console.log(JSON.stringify(entry, null, 1).slice(0, 2200))
}
console.log('providers in quotas.json:', [...new Set(Object.values(q).map((e) => e?.quota?.provider))].join(', '))
