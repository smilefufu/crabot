#!/usr/bin/env node
// Runs real local product components against disposable data; no model calls or desktop input.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { resolve, join, dirname, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

const exec = promisify(execFile)
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await fs.realpath(resolve(process.argv[2] ?? source))
const require = createRequire(import.meta.url)
const product = require(join(root, 'scripts/lib/product-runtime.cjs'))
const pythonEnv = require(join(root, 'scripts/lib/product-python-env.cjs'))
const runtime = product.loadProductRuntime(root, { required: true, full: true })
const data = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'Crabot 产品 中文 ')))
const env = product.productEnvironment(runtime, data, process.env)
const pathKey = process.platform === 'win32' ? Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH' : 'PATH'
if (process.platform === 'win32') {
  // Temporary evidence for the native cross-volume copy failure in run 39066001418.
  // Only sealed Python resource names and a disposable destination are inspected.
  const sync = require('node:fs'), probe = join(data, 'runtime-bases', 'python-' + '0'.repeat(24) + '.building-' + crypto.randomUUID())
  sync.mkdirSync(dirname(probe), { recursive: true })
  sync.cpSync(runtime.pythonHome, probe, { recursive: true, verbatimSymlinks: true })
  console.log('CRABOT_PYTHON_COPY ' + JSON.stringify({
    source_link: sync.lstatSync(runtime.pythonHome).isSymbolicLink(),
    source_entries: sync.readdirSync(runtime.pythonHome).slice(0, 24),
    copied_exists: sync.existsSync(probe),
    copied_entries: sync.existsSync(probe) ? sync.readdirSync(probe).slice(0, 24) : [],
    build_exists: sync.existsSync(join(probe, 'BUILD')),
  }))
  sync.rmSync(probe, { recursive: true, force: true })
  sync.cpSync(runtime.pythonHome, probe, { recursive: true, verbatimSymlinks: true, filter: () => true })
  assert.equal(sync.existsSync(join(probe, 'BUILD')), true, 'Unicode-safe copy must retain the real sealed Python layout')
  console.log('CRABOT_PYTHON_COPY_FILTERED ' + JSON.stringify({ copied_entries: sync.readdirSync(probe).slice(0, 24), build_exists: true }))
  sync.rmSync(probe, { recursive: true, force: true })
}
const pythonPath = pythonEnv.ensureProductAgentVenv(runtime, data)
env[pathKey] = pythonPath
env.DATA_DIR = data
env.CRABOT_AGENT_DATA_DIR = join(data, 'agent')
env.CRABOT_MEMORY_DATA_DIR = join(data, 'memory')
env.CRABOT_JWT_SECRET = 'synthetic-admin-secret-must-not-reach-MCP'
env.UNRELATED_SECRET = 'synthetic-host-secret-must-not-reach-MCP'
env.PYTHONDONTWRITEBYTECODE = '1'
const run = async (command, args, options = {}) => (await exec(command, args, { env, cwd: data, timeout: 90_000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout.trim()
const report = { platform: process.platform, arch: process.arch, version: runtime.manifest.version }
let connector

try {
  report.node = await run(runtime.executables.node, ['--version'])
  assert.equal(await run(runtime.executables.node, ['-p', 'process.execPath']), await fs.realpath(runtime.executables.node))
  const agentPython = join(pythonPath.split(delimiter)[0], process.platform === 'win32' ? 'python.exe' : 'python')
  report.python = await run(agentPython, ['-I', '-c', 'import sys,pip; print(sys.version.split()[0])'])
  assert.match(report.python, /^3\.12\./)
  report.pip = await run(agentPython, ['-I', '-m', 'pip', '--version'])
  assert.ok(report.pip.includes(data))
  const shell = command => run(runtime.executables.bash, ['-c', command])
  report.npm = await shell('npm --version')
  report.npx = await shell('npx --version')
  report.git = await shell('git --version')
  report.rg = await shell('rg --version')
  assert.match(report.git, /^git version /)
  assert.match(report.rg, /^ripgrep /)
  // Exercise child helpers and relocated aliases, rather than only --version.
  const gitConfig = join(data, 'git-config'), hooks = join(data, 'empty-hooks')
  await fs.writeFile(gitConfig, ''); await fs.mkdir(hooks)
  const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig }
  const git = args => run(runtime.executables.git, ['-c', 'core.hooksPath=' + hooks, ...args], { env: gitEnv })
  const repository = join(data, '本地 仓库'), cloned = join(data, '克隆 仓库')
  await git(['-c', 'init.defaultBranch=main', 'init', repository])
  await fs.writeFile(join(repository, 'probe.txt'), 'offline bundled Git\n')
  await git(['-C', repository, 'add', 'probe.txt'])
  await git(['-C', repository, '-c', 'user.name=Crabot Probe', '-c', 'user.email=probe@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'local probe'])
  await git(['clone', '--no-local', repository, cloned])
  assert.equal(await fs.readFile(join(cloned, 'probe.txt'), 'utf8'), 'offline bundled Git\n')
  await git(['-C', cloned, 'fsck', '--full'])
  report.git_local_commit_clone = true
  const background = await shell("python3 -I -c 'print(73)' > background.txt & wait; cat background.txt")
  assert.equal(background, '73')
  report.background_shell = true

  // The core resolves its own interpreter even when a task environment has another PATH.
  Object.assign(process.env, env)
  const resolver = require(join(root, 'crabot-core/dist/executable-resolver.js'))
  const previousPath = process.env[pathKey]
  process.env[pathKey] = data
  try {
    assert.equal(resolver.resolveExecutable('node'), runtime.executables.node)
    assert.equal(resolver.resolveExecutable('uv'), runtime.executables.uv)
  } finally { process.env[pathKey] = previousPath }

  const memoryCode = [
    'import sys,asyncio',
    'sys.path[:0]=sys.argv[1:3]',
    'import src.main',
    'from src.storage.short_term_store import ShortTermStore',
    'from src.types import ShortTermMemoryEntry,MemorySource',
    'async def check():',
    ' store=ShortTermStore(sys.argv[3])',
    ' entry=ShortTermMemoryEntry(content="offline product probe",event_time="2026-10-17T00:00:00Z",source=MemorySource(type="system"),visibility="internal")',
    ' await store.add_short_term(entry)',
    ' actual=await store.get_by_id(entry.id)',
    ' assert actual["row"]["content"]==entry.content',
    ' print("memory-local-read-write-ok")',
    'asyncio.run(check())',
  ].join('\n')
  const memory = await run(runtime.executables.python, ['-I', '-B', '-c', memoryCode, runtime.memoryPackages, join(root, 'crabot-memory'), join(data, 'memory', 'probe.db')])
  assert.equal(memory, 'memory-local-read-write-ok')
  report.memory_local_read_write = true

  // Upgrade scripts use the same standalone interpreters, with private Memory deps,
  // rather than uv sync, Electron Node or an Agent/MCP environment at startup.
  const { runScript } = await import(pathToFileURL(join(root, 'scripts/upgrade-lib/runner.mjs')).href)
  const upgrade = join(data, 'migration-fixture', 'crabot-memory', 'upgrade')
  await fs.mkdir(upgrade, { recursive: true })
  const pythonMigration = join(upgrade, 'probe.py')
  await fs.writeFile(pythonMigration, [
    'import sys,json,yaml',
    'from pathlib import Path',
    'assert sys.flags.isolated == 1',
    'assert not any("agent-venv" in value for value in sys.path)',
    'target=Path(next(value.split("=",1)[1] for value in sys.argv if value.startswith("--data-dir=")))',
    'target.mkdir(parents=True,exist_ok=True)',
    '(target/"migration.json").write_text(json.dumps({"python":str(Path(sys.executable).resolve()),"yaml":str(Path(yaml.__file__).resolve())}),encoding="utf-8")',
  ].join('\n'))
  const migrated = join(data, 'migration-data')
  const migrationEnv = { ...env, PATH: data }
  assert.equal((await runScript(pythonMigration, migrated, { root, env: migrationEnv })).exitCode, 0)
  const migrationResult = JSON.parse(await fs.readFile(join(migrated, 'migration.json'), 'utf8'))
  // Linux's verified entry is a library-path launcher; sys.executable identifies
  // the bundled binary it execs, rather than the wrapper script itself.
  const pythonBinary = join(runtime.pythonHome, process.platform === 'win32' ? 'python.exe'
    : 'bin/python' + runtime.manifest.versions.python.split('.').slice(0, 2).join('.'))
  assert.equal(migrationResult.python, await fs.realpath(pythonBinary))
  assert.ok(migrationResult.yaml.startsWith(await fs.realpath(runtime.memoryPackages)))
  const nodeMigration = join(upgrade, 'probe.mjs')
  await fs.writeFile(nodeMigration, 'import{writeFileSync}from"node:fs";import{join}from"node:path";const data=process.argv.find(value=>value.startsWith("--data-dir=")).slice(11);writeFileSync(join(data,"node.json"),JSON.stringify({node:process.execPath}))')
  assert.equal((await runScript(nodeMigration, migrated, { root, env: migrationEnv })).exitCode, 0)
  assert.equal(JSON.parse(await fs.readFile(join(migrated, 'node.json'), 'utf8')).node, await fs.realpath(runtime.executables.node))
  report.offline_migration_interpreters = true

  const wheels = []
  for (const version of ['1.0', '2.0']) {
    const wheel = join(data, 'crabot_product_probe-' + version + '-py3-none-any.whl')
    const code = [
      'import sys,zipfile',
      'version=sys.argv[2]',
      'prefix="crabot_product_probe-"+version+".dist-info/"',
      'with zipfile.ZipFile(sys.argv[1],"w") as z:',
      ' z.writestr("crabot_product_probe/__init__.py","VERSION="+repr(version))',
      ' z.writestr(prefix+"METADATA","Metadata-Version: 2.1\\nName: crabot-product-probe\\nVersion: "+version+"\\n")',
      ' z.writestr(prefix+"WHEEL","Wheel-Version: 1.0\\nGenerator: crabot-probe\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")',
      ' z.writestr(prefix+"RECORD","")',
    ].join('\n')
    await run(agentPython, ['-I', '-c', code, wheel, version])
    wheels.push(wheel)
  }
  const mcpConfigs = [{ name: 'probe-node', command: 'node', args: [join(source, '.github/scripts/fixtures/product-mcp.mjs')] }]
  for (let index = 0; index < wheels.length; index++) {
    const mcpPath = pythonEnv.ensureProductMcpVenv(runtime, data, 'probe-' + index)
    const python = join(mcpPath.split(delimiter)[0], process.platform === 'win32' ? 'python.exe' : 'python')
    await run(runtime.executables.uv, ['pip', 'install', '--offline', '--no-index', '--python', python, wheels[index]])
    mcpConfigs.push({ name: 'probe-python-' + index, command: python, args: [join(source, '.github/scripts/fixtures/product-mcp.py')] })
  }
  const { McpConnector } = await import(pathToFileURL(join(root, 'crabot-agent/dist/agent/mcp-connector.js')).href)
  connector = new McpConnector()
  await connector.connectAll(mcpConfigs)
  assert.equal(connector.count, 3)
  assert.equal(connector.getAllTools().length, 3)
  const values = []
  for (const config of mcpConfigs) {
    const result = await connector.getClient(config.name).callTool({ name: 'runtime', arguments: {} })
    values.push(JSON.parse(result.content[0].text))
  }
  assert.equal(values[0].node, await fs.realpath(runtime.executables.node))
  assert.ok(values[0].python.includes(join(data, 'agent-venv')))
  assert.equal(values[0].secret_inherited, false)
  assert.equal(values[0].npm_cache, env.npm_config_cache)
  assert.equal(values[0].uv_cache, env.UV_CACHE_DIR)
  assert.equal(values[1].version, '1.0')
  assert.equal(values[2].version, '2.0')
  await assert.rejects(run(agentPython, ['-I', '-c', 'import crabot_product_probe']), /crabot_product_probe/)
  report.mcp = { actual_stdio_connections: connector.count, dependency_versions: values.slice(1).map(value => value.version), admin_credentials_inherited: false }

  const browser = JSON.parse(await fs.readFile(join(root, 'scrapling-runtime.json'), 'utf8'))
  const browserCode = [
    'import sys',
    'sys.path.insert(0,sys.argv[1])',
    'from playwright.sync_api import sync_playwright',
    'with sync_playwright() as p:',
    ' browser=p.chromium.launch(executable_path=sys.argv[2],headless=True,args=["--no-sandbox"])',
    ' page=browser.new_page()',
    ' page.set_content("<title>Crabot local browser</title><main>ready</main>")',
    ' assert page.title()=="Crabot local browser"',
    ' browser.close()',
    'print("browser-local-page-ok")',
  ].join('\n')
  const output = await run(runtime.executables.python, ['-I', '-B', '-c', browserCode, join(root, browser.directory, 'packages'), join(root, runtime.manifest.browser)], {
    env: { ...env, PLAYWRIGHT_BROWSERS_PATH: join(root, browser.directory, 'browsers') },
  })
  assert.equal(output, 'browser-local-page-ok')
  report.browser_local_page = true
  product.loadProductRuntime(root, { required: true, full: true })
  report.product_resources_unchanged = true
  console.log(JSON.stringify(report, null, 2))
} finally {
  await connector?.disconnectAll()
  await fs.rm(data, { recursive: true, force: true })
}
