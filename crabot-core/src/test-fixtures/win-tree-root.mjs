import { spawn } from 'node:child_process'
import fs from 'node:fs'

// Root of a module tree: leaves a detached descendant behind when killed abruptly.
const [pidFile] = process.argv.slice(2)
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' })
child.unref()
fs.writeFileSync(pidFile, JSON.stringify({ root: process.pid, child: child.pid }))
setTimeout(() => {}, 30000)
