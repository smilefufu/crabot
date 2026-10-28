#!/usr/bin/env node
// Real offline dependency installation and Agent stdio connections; never starts MM.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join, dirname, resolve, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))
const require = createRequire(join(root, 'crabot-admin/package.json'))
const AdmZip = require('adm-zip')
const { MCPServerManager } = require(join(root, 'crabot-admin/dist/mcp-skill-manager.js'))
const { resolveManagedMcpConfig } = require(join(root, 'crabot-admin/dist/managed-mcp-runtime.js'))
const { McpConnector } = await import(pathToFileURL(join(root, 'crabot-agent/dist/agent/mcp-connector.js')).href)
const { ensureProductAgentVenv } = require(join(root, 'scripts/lib/product-python-env.cjs'))
const { verifyCoreRelease } = await import(pathToFileURL(join(root, 'scripts/lib/core-release.mjs')).href)
const { loadProductRuntime } = require(join(root, 'scripts/lib/product-runtime.cjs'))
const runtime = loadProductRuntime(root, { required: true, full: true })
const exec = promisify(execFile)
const data = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'Crabot MCP 中文 ')))
const registry = new MCPServerManager(data, true)
const connector = new McpConnector()
const inheritedSecret = process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER
process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = 'synthetic-must-not-reach-mcp'
const run = async (command, args, env) => (await exec(command, args, {
  env: { ...process.env, ...env }, cwd: data, timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true,
})).stdout.trim()
const nodeServer = `#!/usr/bin/env node
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line); if(q.id===undefined)return; let result;
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}};
 else if(q.method==='tools/list')result={tools:[{name:'probe',description:'offline isolation probe',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
 else if(q.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({version:require('./package.json').version,token:process.env.MCP_TEST_TOKEN,bearer:process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER??null})}]};
 else result={}; console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
});
`
const pythonServer = `import sys,json,os,crabot_isolation_probe
for line in sys.stdin:
 q=json.loads(line)
 if 'id' not in q: continue
 method=q['method']
 if method=='initialize': result={'protocolVersion':q['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'probe','version':'1'}}
 elif method=='tools/list': result={'tools':[{'name':'probe','description':'offline isolation probe','inputSchema':{'type':'object','properties':{},'additionalProperties':False}}]}
 elif method=='tools/call': result={'content':[{'type':'text','text':json.dumps({'version':crabot_isolation_probe.version,'prefix':sys.prefix,'token':os.environ.get('MCP_TEST_TOKEN'),'bearer':os.environ.get('CRABOT_CORE_AGENT_RUNTIME_BEARER')})}]}
 else: result={}
 print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':result}),flush=True)
`

try {
  const agentPath = ensureProductAgentVenv(runtime, data)
  const agentPython = join(agentPath.split(delimiter)[0], process.platform === 'win32' ? 'python.exe' : 'python')
  await registry.initializeLoadOnly()
  const pythonFile = join(data, 'stdio probe.py')
  await fs.writeFile(pythonFile, pythonServer)
  const configs = []
  for (const version of ['1.0.0', '2.0.0']) {
    const pythonEntry = await registry.create({ name: 'python-' + version, command: 'python', args: [pythonFile],
      managed_runtime: 'python', env: { MCP_TEST_TOKEN: 'own-' + version } })
    const py = await resolveManagedMcpConfig(root, data, pythonEntry, registry.toAgentConfig(pythonEntry))
    const archive = new AdmZip()
    const dist = 'crabot_isolation_probe-' + version + '.dist-info/'
    archive.addFile('crabot_isolation_probe.py', Buffer.from(`version = '${version}'\ndef main():\n` + pythonServer.split('\n').map(line => ' '+line).join('\n')))
    archive.addFile(dist + 'METADATA', Buffer.from(`Metadata-Version: 2.1\nName: crabot-isolation-probe\nVersion: ${version}\n`))
    archive.addFile(dist + 'WHEEL', Buffer.from('Wheel-Version: 1.0\nGenerator: crabot-offline-probe\nRoot-Is-Purelib: true\nTag: py3-none-any\n'))
    archive.addFile(dist + 'entry_points.txt', Buffer.from('[console_scripts]\ncrabot-isolation-probe=crabot_isolation_probe:main\n'))
    archive.addFile(dist + 'RECORD', Buffer.from(''))
    const wheel = join(data, `crabot_isolation_probe-${version}-py3-none-any.whl`)
    archive.writeZip(wheel)
    await run(py.command, ['-m', 'pip', 'install', '--no-index', '--no-deps', wheel], py.env)
    configs.push(py)
    const again = await resolveManagedMcpConfig(root, data, await registry.update(pythonEntry.id, { name: pythonEntry.name + '-renamed' }), registry.toAgentConfig(pythonEntry))
    assert.equal(again.command, py.command)
    assert.equal(again.env.VIRTUAL_ENV, py.env.VIRTUAL_ENV)

    const nodeEntry = await registry.create({ name: 'node-' + version, command: 'npx', args: ['--offline', 'crabot-isolation-probe'],
      managed_runtime: 'node', env: { MCP_TEST_TOKEN: 'own-' + version } })
    const node = await resolveManagedMcpConfig(root, data, nodeEntry, registry.toAgentConfig(nodeEntry))
    const pkg = join(data, 'package-' + version)
    await fs.mkdir(pkg)
    await fs.writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'crabot-isolation-probe', version, bin: { 'crabot-isolation-probe': 'cli.cjs' } }))
    await fs.writeFile(join(pkg, 'cli.cjs'), nodeServer, { mode: 0o755 })
    const npm = join(dirname(node.args[0]), 'npm-cli.js')
    const packed = JSON.parse(await run(node.command, [npm, 'pack', pkg, '--json', '--offline', '--ignore-scripts', '--pack-destination', data], node.env))
    await run(node.command, [npm, 'install', '--global', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', join(data, packed[0].filename)], node.env)
    configs.push(node)
  }
  assert.notEqual(configs[0].env.VIRTUAL_ENV, configs[2].env.VIRTUAL_ENV)
  assert.notEqual(configs[1].env.npm_config_prefix, configs[3].env.npm_config_prefix)
  assert.equal(configs[1].command, configs[3].command)
  const custom = { id: 'old', name: 'old', command: 'npx', args: ['own'], env: { PATH: 'custom' } }
  assert.equal(await resolveManagedMcpConfig(root, data, custom, custom), custom)
  const uvxEntry = await registry.create({ name: 'uvx-1.0.0', command: 'uvx',
    args: ['--offline', '--from', join(data, 'crabot_isolation_probe-1.0.0-py3-none-any.whl'), 'crabot-isolation-probe'] })
  assert.equal(uvxEntry.managed_runtime, 'python')
  const uvx = await resolveManagedMcpConfig(root, data, uvxEntry, registry.toAgentConfig(uvxEntry))
  configs.push(uvx)
  await connector.connectAll(configs)
  assert.equal(connector.count, 5)
  assert.equal(connector.getAllTools().length, 5)
  for (const config of configs) {
    const result = await connector.getClient(config.name).callTool({ name: 'probe', arguments: {} })
    const probe = JSON.parse(result.content[0].text)
    const version = config.name.endsWith('1.0.0') ? '1.0.0' : '2.0.0'
    assert.equal(probe.version, version)
    if (config.name !== 'uvx-1.0.0') assert.equal(probe.token, 'own-' + version)
    assert.equal(probe.bearer, null)
    if (config.env.VIRTUAL_ENV && config.name !== 'uvx-1.0.0') assert.equal(await fs.realpath(probe.prefix), await fs.realpath(config.env.VIRTUAL_ENV))
  }
  // A failed managed environment cannot silently fall back to a host interpreter or overwrite its packages.
  const broken = configs[0].env.VIRTUAL_ENV
  const marker = join(broken, '.crabot-runtime.json')
  const before = await fs.readFile(marker)
  await fs.writeFile(marker, '{}')
  const entry = registry.list().find(entry => entry.id === configs[0].id)
  await assert.rejects(resolveManagedMcpConfig(root, data, entry, registry.toAgentConfig(entry)), /CRABOT_MCP_ENV_PREPARE_FAILED/)
  assert.equal(registry.get(entry.id).enabled, true)
  await fs.writeFile(marker, before)
  assert.equal((await resolveManagedMcpConfig(root, data, entry, registry.toAgentConfig(entry))).command, configs[0].command)
  const absentProbe = 'import importlib.util; assert importlib.util.find_spec("crabot_isolation_probe") is None'
  await run(agentPython, ['-I', '-X', 'utf8', '-c', absentProbe], {})
  await run(runtime.executables.python, ['-I', '-X', 'utf8', '-B', '-c', absentProbe], {})
  loadProductRuntime(root, { required: true, full: true })
  if (await fs.stat(join(root, 'core-release.json')).catch(() => null)) await verifyCoreRelease(root)
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, managed_stdio_servers: 5,
    offline_conflicting_dependencies: true, agent_and_product_unchanged: true, stable_id_reuse: true, own_credentials_preserved: true,
    internal_bearer_filtered: true, damaged_environment_preserved: true, no_mm: true }))
} finally {
  await connector.disconnectAll()
  if (inheritedSecret === undefined) delete process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER
  else process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = inheritedSecret
  await fs.rm(data, { recursive: true, force: true })
}
