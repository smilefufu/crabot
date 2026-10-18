#!/usr/bin/env node
// Full immutable user CLI update, no MM/model/network/real profile modifications.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const [oldArgument, nextArgument, archiveArgument] = process.argv.slice(2)
if (!oldArgument || !nextArgument) throw new Error('Expected previous and target complete core directories')
const old = await fs.realpath(resolve(oldArgument)), next = await fs.realpath(resolve(nextArgument))
const require = createRequire(import.meta.url)
const product = require(join(next, 'scripts/lib/product-runtime.cjs'))
const pythonEnv = require(join(next, 'scripts/lib/product-python-env.cjs'))
const { installStandaloneCli } = await import(pathToFileURL(join(next, 'scripts/lib/standalone-cli-install.mjs')))
const { readCliSelection, prepareCliPayload } = await import(pathToFileURL(join(next, 'scripts/lib/cli-installation.mjs')))
const { inspectInstance } = await import(pathToFileURL(join(next, 'scripts/lib/instance-runtime.mjs')))
const { readVersionMaintenance } = await import(pathToFileURL(join(next, 'scripts/lib/version-maintenance.mjs')))
const { verifyCoreRelease } = await import(pathToFileURL(join(next, 'scripts/lib/core-release.mjs')))
const { verifyMaintenanceBackup } = await import(pathToFileURL(join(next, 'scripts/lib/maintenance-backup.mjs')))
const { downloadRelease } = await import('../../scripts/upgrade-lib/release.mjs')
const { applyDownloadedCliUpgrade } = await import('../../scripts/lib/standalone-cli-release.mjs')
const execute = promisify(execFile)
const temporary = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'Crabot CLI 升级 ')))
const dataDir = join(temporary, '实例'), installRoot = join(temporary, '程序')
const env = { ...process.env, DATA_DIR: dataDir }
const run = async (command, args) => (await execute(command, args, { env, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout
try {
  const one = await installStandaloneCli({ sourceRoot: old, installRoot, dataDir })
  const runtime = product.loadProductRuntime(one.coreRoot, { required: true })
  const agentPath = pythonEnv.ensureProductAgentVenv(runtime, dataDir)
  const mcpPath = pythonEnv.ensureProductMcpVenv(runtime, dataDir, 'stable-custom-mcp-id')
  const environments = [agentPath, mcpPath].map(value => join(value.split(delimiter)[0], process.platform === 'win32' ? 'python.exe' : 'python'))
  const installProbe = 'import sysconfig,pathlib; pathlib.Path(sysconfig.get_path("purelib"),"crabot_upgrade_probe.py").write_text("value = 2026\\n")'
  for (const python of environments) await run(python, ['-I', '-X', 'utf8', '-B', '-c', installProbe])
  await fs.mkdir(join(dataDir, 'workspaces/task'), { recursive: true })
  await fs.writeFile(join(dataDir, 'workspaces/task/keep'), 'user artifact')
  await fs.mkdir(join(dataDir, 'admin'), { recursive: true })
  const adminSchema = await fs.readFile(join(old, 'crabot-admin/schema_version')).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (adminSchema) await fs.writeFile(join(dataDir, 'admin/SCHEMA_VERSION'), adminSchema)
  await fs.writeFile(join(dataDir, 'admin/upgrade-probe.json'), '{"preserve":true}')
  const targetVersion = (await verifyCoreRelease(next)).version
  let two
  if (archiveArgument) {
    const archive = await fs.realpath(resolve(archiveArgument))
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    const checksum = hash.digest('hex'), requests = []
    const endpoint = archive.endsWith('.zip') ? '/core.zip' : '/core.tar.gz'
    const server = createServer((req, res) => {
      requests.push(req.url)
      if (req.url === endpoint) createReadStream(archive).pipe(res)
      else if (req.url === endpoint + '.sha256') res.end(checksum)
      else { res.statusCode = 404; res.end() }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    try {
      const url = `http://127.0.0.1:${server.address().port}${endpoint}`
      const logger = { info: console.log, warn: console.warn, error: console.error }
      const artifact = await downloadRelease({ url, sha256Url: url + '.sha256', version: 'v' + targetVersion, logger })
      two = await applyDownloadedCliUpgrade({ root: one.coreRoot, dataDir, artifact, logger })
      assert.equal((await fs.stat(artifact.tmp).catch(() => null)), null)
      assert.deepEqual(requests, [endpoint, endpoint + '.sha256'])
    } finally { await new Promise(resolve => server.close(resolve)) }
  } else {
    two = await prepareCliPayload({ sourceRoot: next, installRoot, version: targetVersion })
    assert.equal(readCliSelection(installRoot), one.id)
    const targetRuntime = product.loadProductRuntime(two.coreRoot, { required: true })
    const stdout = await run(targetRuntime.executables.node, [join(two.coreRoot, 'scripts/apply-cli-update.mjs'), one.coreRoot, dataDir])
    assert.match(stdout, /服务保持停止/)
  }
  assert.equal(readCliSelection(installRoot), two.id)
  assert.equal(inspectInstance(dataDir).state, 'stopped')
  assert.equal(readVersionMaintenance(dataDir), null)
  assert.equal(await fs.readFile(join(dataDir, 'admin/upgrade-probe.json'), 'utf8'), '{"preserve":true}')
  assert.equal(await fs.readFile(join(dataDir, 'workspaces/task/keep'), 'utf8'), 'user artifact')
  for (const python of environments) assert.equal((await run(python, ['-I', '-X', 'utf8', '-B', '-c', 'import crabot_upgrade_probe; print(crabot_upgrade_probe.value)'])).trim(), '2026')
  const versionOutput = await run(one.command, ['--version'])
  assert.ok(versionOutput.includes(two.version))
  const backups = await fs.readdir(dataDir + '.desktop-backups')
  assert.equal(backups.length, 1)
  await verifyMaintenanceBackup(join(dataDir + '.desktop-backups', backups[0]))
  assert.equal((await verifyCoreRelease(one.coreRoot)).version, one.version)
  assert.equal((await verifyCoreRelease(two.coreRoot)).version, two.version)
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, from: one.version, to: two.version,
    target_bundled_node: true, full_archive_download_checksum_extract: Boolean(archiveArgument), native_command_selected_target: true, scoped_backup_verified: true,
    stable_agent_and_mcp_python_preserved: true, workspaces_preserved: true, immutable_payloads_verified: true,
    no_mm_started: true, health_verified: false }))
} finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
