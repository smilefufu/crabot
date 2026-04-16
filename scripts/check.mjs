#!/usr/bin/env node

// Crabot Check — 检查各模块运行状态

const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)

const services = [
  { name: 'Module Manager', port: 19000 + OFFSET },
  { name: 'Admin (RPC)',    port: 19001 + OFFSET },
  { name: 'Admin (Web)',    port: 3000 + OFFSET },
]

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red   = (s) => `\x1b[31m${s}\x1b[0m`
const bold  = (s) => `\x1b[1m${s}\x1b[0m`

console.log(bold('\n  Crabot Status\n'))

for (const svc of services) {
  try {
    const res = await fetch(`http://localhost:${svc.port}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (res.ok) {
      console.log(`  ${green('●')} ${svc.name.padEnd(20)} :${svc.port}`)
    } else {
      console.log(`  ${red('●')} ${svc.name.padEnd(20)} :${svc.port}  (HTTP ${res.status})`)
    }
  } catch {
    console.log(`  ${red('●')} ${svc.name.padEnd(20)} :${svc.port}  (unreachable)`)
  }
}

console.log()
