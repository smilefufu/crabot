// Exercise the real standalone launcher and native production dependencies.
// No business MM, desktop input or model provider is started.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyCoreRelease } from '../../scripts/lib/core-release.mjs'

const root = await fs.realpath(path.resolve(process.argv[2]))
const metadata = await verifyCoreRelease(root)
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'crabot-core-package-'))
const execute = promisify(execFile)
try {
  const bin = path.join(temporary, 'bin'); await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'node'), '#!/bin/sh\necho HOST_NODE_MUST_NOT_RUN\nexit 77\n', { mode: 0o755 })
  const env = { ...process.env, DATA_DIR: path.join(temporary, 'data') }
  delete env.NODE_OPTIONS
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = process.platform === 'win32' ? bin : [bin, '/usr/bin', '/bin'].join(path.delimiter)
  const launcher = path.join(root, process.platform === 'win32' ? 'bin/crabot.cmd' : 'bin/crabot')
  env.CRABOT_STAGED_LAUNCHER = launcher
  const command = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/cmd.exe') : launcher
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', '""%CRABOT_STAGED_LAUNCHER%" --version"'] : ['--version']
  const version = (await execute(command, args, { env, cwd: temporary, timeout: 30_000, windowsVerbatimArguments: process.platform === 'win32' })).stdout.trim()
  assert.equal(version, metadata.version)
  const node = path.join(root, process.platform === 'win32' ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const probe = 'const {createRequire}=require("node:module");const path=require("node:path");const root=process.argv[1];const load=createRequire(path.join(root,"crabot-admin/package.json"));const Database=load("better-sqlite3");const db=new Database(":memory:");if(db.prepare("select 71 as answer").get().answer!==71)throw Error("native SQLite failed");db.close();const native=require(path.join(root,"scripts/lib/process-identity.cjs"));if(!native.inspectProcess(process.pid))throw Error("native identity failed");console.log(JSON.stringify({node:process.versions.node,sqlite:true,identity:true}))'
  const native = JSON.parse((await execute(node, ['-e', probe, root], { env, cwd: temporary, timeout: 30_000 })).stdout)
  assert.equal(native.node, '22.22.3'); assert.equal(native.sqlite, true); assert.equal(native.identity, true)
  for (const forbidden of ['.env', '.git', 'data', 'crabot-desktop', 'crabot-admin/web/src', 'crabot-admin/test-data', 'crabot-core/src']) {
    await assert.rejects(fs.lstat(path.join(root, forbidden)), { code: 'ENOENT' }, forbidden)
  }
  console.log('CRABOT_STAGED_CORE ' + JSON.stringify({ platform: process.platform, arch: process.arch, version, host_node_unused: true, native_dependencies: native }))
} finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
