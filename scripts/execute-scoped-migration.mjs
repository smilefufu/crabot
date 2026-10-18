import path from 'node:path'
import { spawn } from 'node:child_process'
import { describeMigration, executeMigration } from './upgrade-lib/migration-transaction.mjs'
const args = Object.fromEntries(process.argv.slice(2).map(value => { const i = value.indexOf('='); return [value.slice(2, i), value.slice(i + 1)] }))
if (!args.module || !args.data || !args.from || !args.to || !args.python) throw new Error('Incomplete standalone migration arguments')
const description = await describeMigration(path.resolve(args.module), path.resolve(args.data), args.from, args.to)
let report = null
const result = await executeMigration(description, (script, data, context) => new Promise((resolve, reject) => {
  const child = spawn(args.python, [script, `--data-dir=${data}`], { env: { ...process.env, ...context.environment, CRABOT_MIGRATION_PLAN: context.plan, CRABOT_MIGRATION_PLAN_SHA256: context.planSha256 }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk; process.stderr.write(chunk) })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  child.on('error', reject)
  child.on('close', exitCode => {
    try { report = JSON.parse(stdout.trim().split('\n').at(-1)) } catch { /* Earlier migrations print progress rather than JSON. */ }
    resolve({ exitCode: exitCode ?? 1 })
  })
}), { throwOnFailure: true, advanceVersion: false })
console.log(JSON.stringify({ ...result, report }))
