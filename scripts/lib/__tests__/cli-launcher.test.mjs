import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'

const windows = process.platform === 'win32'
const name = windows ? 'crabot.exe' : 'crabot'
const binary = new URL('../../../crabot-native/build/Release/' + name, import.meta.url)
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 原生命令 ')))
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = path.join(directory, '安装 核心'), executable = path.join(root, 'bin', name)
  const node = path.join(root, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.mkdir(path.dirname(node), { recursive: true })
  await fs.copyFile(binary, executable)
  await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE)
  if (!windows) { await fs.chmod(executable, 0o755); await fs.chmod(node, 0o755) }
  await fs.writeFile(path.join(root, 'core-release.json'), '{}')
  await fs.writeFile(path.join(root, 'cli.mjs'), 'if(process.argv[2]==="wait"){process.on("SIGTERM",()=>process.exit(23));console.log("ready");setInterval(()=>{},1000)}else{console.log(JSON.stringify({args:process.argv.slice(2),pid:process.pid,exe:process.execPath,required:process.env.CRABOT_PRODUCT_REQUIRED}));process.exit(Number(process.env.TEST_EXIT||0))}')
  return { directory, root, executable, node }
}

test('the actual native command preserves Unicode, empty arguments, quotes and exit codes using bundled Node', async t => {
  const f = await fixture(t), args = ['status', '', '中文 空格', 'a"b', 'trailing\\', 'back\\"slash', 'literal&value', "single'quote"]
  const { stdout } = await promisify(execFile)(f.executable, args, { env: { ...process.env, PATH: '', CRABOT_PRODUCT_REQUIRED: '0' } })
  const result = JSON.parse(stdout)
  assert.deepEqual(result.args, args); assert.equal(result.exe, f.node); assert.equal(result.required, '1')
  await assert.rejects(promisify(execFile)(f.executable, [], { env: { ...process.env, TEST_EXIT: '37' } }), { code: 37 })
})

test('a stable native command follows only the complete selected version and never falls back to a host interpreter', async t => {
  const f = await fixture(t), container = path.join(f.directory, '独立 CLI'), id = 'a'.repeat(64)
  await fs.mkdir(path.join(container, 'bin'), { recursive: true }); await fs.mkdir(path.join(container, 'releases'))
  const command = path.join(container, 'bin', name), payload = path.join(container, 'releases', id)
  await fs.copyFile(f.executable, command); if (!windows) await fs.chmod(command, 0o755)
  await fs.rename(f.root, payload); await fs.writeFile(path.join(container, 'current-core'), id + '\n')
  const { stdout } = await promisify(execFile)(command, ['--version'])
  assert.equal(JSON.parse(stdout).exe, path.join(payload, path.relative(f.root, f.node)))
  await fs.rm(path.join(payload, path.relative(f.root, f.node)))
  await assert.rejects(promisify(execFile)(command, ['--version']), { code: 127 })
  for (const selector of ['../escape\n', id + '\nextra', 'b'.repeat(64) + '\n', '']) {
    await fs.writeFile(path.join(container, 'current-core'), selector)
    await assert.rejects(promisify(execFile)(command, []), { code: 127 })
  }
})

test('POSIX exec preserves the command PID and forwards foreground signals directly to Node', { skip: windows }, async t => {
  const f = await fixture(t), child = spawn(f.executable, ['wait'], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
  const result = once(child, 'exit'); child.kill('SIGTERM')
  assert.deepEqual(await result, [23, null])
})
