const res = await fetch('http://127.0.0.1:3425/v1/magpie/quotas?all=1')
const body = await res.json()
const data = body.data || []

const pick = (id, n = 1) => data.filter((e) => e.provider === id).slice(0, n)
for (const id of ['codearts', 'zcode', 'autoclaw']) {
  for (const entry of pick(id, 1)) {
    console.log(`\n================ ${id} · ${entry.user} ================`)
    console.log(JSON.stringify(entry, null, 1).slice(0, 3000))
  }
}
console.log('\n---- 其它参数试试 ----')
for (const q of ['', '?all=1&slim=1', '?provider=zcode', '?splits=0']) {
  const r = await fetch(`http://127.0.0.1:3425/v1/magpie/quotas${q}`)
  const t = await r.text()
  let n = 0
  try {
    n = (JSON.parse(t).data || []).length
  } catch {}
  console.log(`  /v1/magpie/quotas${q} -> ${r.status} 条数 ${n}`)
}
