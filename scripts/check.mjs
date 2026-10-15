#!/usr/bin/env node

// Crabot Check — 检查各模块运行状态

import { probeMmModules } from './lib/mm-probe.mjs'

const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)

const mmPort = 19000 + OFFSET
const modules = await probeMmModules(mmPort)
const adminPort = modules?.find((m) => m.module_id === 'admin-web')?.port
const rpcOptions = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
}

const services = [
  { name: 'Module Manager', port: mmPort, options: rpcOptions },
  { name: 'Admin (RPC)',    port: adminPort, options: rpcOptions },
  { name: 'Admin (Web)',    port: 3000 + OFFSET },
]

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red   = (s) => `\x1b[31m${s}\x1b[0m`
const bold  = (s) => `\x1b[1m${s}\x1b[0m`

console.log(bold('\n  Crabot Status\n'))

for (const svc of services) {
  if (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535) {
    console.log(`  ${red('●')} ${svc.name.padEnd(20)} (port unavailable)`)
    continue
  }
  try {
    const res = await fetch(`http://localhost:${svc.port}/health`, {
      ...svc.options,
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
