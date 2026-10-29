#!/usr/bin/env node
// Full immutable user CLI update, no MM/model/network/real profile modifications.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join, resolve, delimiter, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startDesktopDiskObservation } from './desktop-disk.mjs'
const [oldArgument, nextArgument, archiveArgument, commandMode] = process.argv.slice(2)
const cliCommand = commandMode === '--cli-command'
if (commandMode && !cliCommand) throw new Error('Unknown fixture option')
if (cliCommand && !archiveArgument) throw new Error('CLI command fixture requires a full archive')
if (!oldArgument || !nextArgument) throw new Error('Expected previous and target complete core directories')
const old = await fs.realpath(resolve(oldArgument)), next = await fs.realpath(resolve(nextArgument))
const require = createRequire(import.meta.url)
const product = require(join(next, 'scripts/lib/product-runtime.cjs'))
const pythonEnv = require(join(next, 'scripts/lib/product-python-env.cjs'))
const { installStandaloneCli } = await import(pathToFileURL(join(next, 'scripts/lib/standalone-cli-install.mjs')))
const { readCliSelection, prepareCliPayload } = await import(pathToFileURL(join(next, 'scripts/lib/cli-installation.mjs')))
const { inspectInstance } = await import(pathToFileURL(join(next, 'scripts/lib/instance-runtime.mjs')))
const { readVersionMaintenance } = await import(pathToFileURL(join(next, 'scripts/lib/version-maintenance.mjs')))
const { writeCoreRelease, verifyCoreRelease } = await import(pathToFileURL(join(next, 'scripts/lib/core-release.mjs')))
const { verifyBackup } = await import(pathToFileURL(join(next, 'scripts/upgrade-lib/scoped-data.mjs')))
const { previewMigrations } = await import(pathToFileURL(join(next, 'scripts/upgrade-lib/migrate.mjs')))
const { downloadRelease } = await import('../../scripts/upgrade-lib/release.mjs')
const { applyDownloadedCliUpgrade } = await import('../../scripts/lib/standalone-cli-release.mjs')
const execute = promisify(execFile)
const temporary = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'Crabot CLI 升级 ')))
const dataDir = join(temporary, '实例'), installRoot = join(temporary, '程序')
const env = { ...process.env, DATA_DIR: dataDir }
const run = async (command, args) => (await execute(command, args, { env, timeout: args[0] === 'upgrade' ? 600_000 : 180_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout
let disk, updateComplete = false
const started = Date.now(), stage = phase => console.log('CRABOT_CLI_UPDATE_STAGE ' + JSON.stringify({ platform: process.platform, phase, elapsed_ms: Date.now() - started }))
try {
  stage('preparing-previous-fixture')
  let sourceRoot = old
  if (cliCommand) {
    // Explicit synthetic previous release with the current command code; this is
    // command dispatch acceptance, not compatibility evidence for a published old release.
    sourceRoot = join(temporary, 'previous-core-fixture')
    await fs.cp(old, sourceRoot, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: () => true })
    const metadata = await verifyCoreRelease(sourceRoot)
    const version = '0.0.0-cli-update-fixture'
    for (const file of ['package.json', 'product-runtime.json']) {
      const value = JSON.parse(await fs.readFile(join(sourceRoot, file), 'utf8'))
      await fs.writeFile(join(sourceRoot, file), JSON.stringify({ ...value, version }))
    }
    await fs.rm(join(sourceRoot, 'core-files.json')); await fs.rm(join(sourceRoot, 'core-release.json'))
    await writeCoreRelease(sourceRoot, { ...metadata, version })
  }
  stage('installing-previous-core')
  const one = await installStandaloneCli({ sourceRoot, installRoot, dataDir })
  const runtime = product.loadProductRuntime(one.coreRoot, { required: true })
  stage('preparing-python-environments')
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
  disk = await startDesktopDiskObservation(temporary)
  let two
  if (archiveArgument) {
    stage('reading-release-archive')
    let archivePath = resolve(archiveArgument), archiveReport
    if (archiveArgument.endsWith('.json')) {
      archiveReport = JSON.parse(await fs.readFile(archivePath, 'utf8'))
      assert.equal(archiveReport.candidate_only, true)
      assert.equal(archiveReport.roundtrip_verified, true)
      assert.equal(archiveReport.file, archiveReport.file.split(/[\\/]/).at(-1))
      assert.equal(archiveReport.version, targetVersion)
      archivePath = resolve(dirname(archivePath), archiveReport.file)
    }
    const archive = await fs.realpath(archivePath)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    const checksum = hash.digest('hex'), requests = []
    if (archiveReport) assert.equal(archiveReport.sha256, checksum)
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
      if (cliCommand) {
        const releaseBase = `https://github.com/smilefufu/crabot/releases/download/v${targetVersion}/crabot-v${targetVersion}-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${archive.endsWith('.zip') ? '.zip' : '.tar.gz'}`
        const hook = join(temporary, 'release-fetch-fixture.mjs')
        await fs.writeFile(hook, `const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const u=String(input);if(u==='https://github.com/smilefufu/crabot/releases/latest')return Promise.resolve(new Response(null,{status:302,headers:{location:'https://github.com/smilefufu/crabot/releases/tag/v${targetVersion}'}}));if(u===${JSON.stringify(releaseBase)})return original(${JSON.stringify(url)},options);if(u===${JSON.stringify(releaseBase + '.sha256')})return original(${JSON.stringify(url + '.sha256')},options);throw new Error('Unexpected fixture request');};`)
        const prior = env.NODE_OPTIONS
        env.NODE_OPTIONS = '--import=' + pathToFileURL(hook).href
        stage('executing-cli-upgrade')
        try { assert.match(await run(one.command, ['upgrade', '--yes']), /服务保持停止/) }
        finally { if (prior === undefined) delete env.NODE_OPTIONS; else env.NODE_OPTIONS = prior }
        const id = readCliSelection(installRoot)
        two = { coreRoot: join(installRoot, 'releases', id), id, version: targetVersion }
      } else {
        const artifact = await downloadRelease({ url, sha256Url: url + '.sha256', version: 'v' + targetVersion, logger })
        two = await applyDownloadedCliUpgrade({ root: one.coreRoot, dataDir, artifact, logger })
        assert.equal((await fs.stat(artifact.tmp).catch(() => null)), null)
      }
      assert.deepEqual(requests, [endpoint, endpoint + '.sha256'])
    } finally { await new Promise(resolve => server.close(resolve)) }
  } else {
    two = await prepareCliPayload({ sourceRoot: next, installRoot, version: targetVersion })
    assert.equal(readCliSelection(installRoot), one.id)
    const targetRuntime = product.loadProductRuntime(two.coreRoot, { required: true })
    const stdout = await run(targetRuntime.executables.node, [join(two.coreRoot, 'scripts/apply-cli-update.mjs'), one.coreRoot, dataDir])
    assert.match(stdout, /服务保持停止/)
  }
  stage('verifying-upgrade-receipts')
  assert.equal(readCliSelection(installRoot), two.id)
  assert.equal(inspectInstance(dataDir).state, 'stopped')
  assert.equal(readVersionMaintenance(dataDir), null)
  assert.equal(await fs.readFile(join(dataDir, 'admin/upgrade-probe.json'), 'utf8'), '{"preserve":true}')
  assert.equal(await fs.readFile(join(dataDir, 'workspaces/task/keep'), 'utf8'), 'user artifact')
  for (const python of environments) assert.equal((await run(python, ['-I', '-X', 'utf8', '-B', '-c', 'import crabot_upgrade_probe; print(crabot_upgrade_probe.value)'])).trim(), '2026')
  const versionOutput = await run(one.command, ['--version'])
  assert.ok(versionOutput.includes(two.version))
  await assert.rejects(fs.lstat(dataDir + '.desktop-backups'), { code: 'ENOENT' })
  const remaining = await previewMigrations(two.coreRoot, dataDir)
  assert.equal(remaining.modules.length, 0); assert.equal(remaining.backup_bytes, 0)
  const migrations = join(dataDir, '.upgrade-migrations')
  const transactions = await fs.readdir(migrations).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  for (const name of transactions) {
    const transaction = join(migrations, name), bytes = await fs.readFile(join(transaction, 'plan.json'))
    const plan = JSON.parse(bytes), state = JSON.parse(await fs.readFile(join(transaction, 'state.json'), 'utf8'))
    assert.equal(state.phase, 'completed'); assert.equal(state.plan_sha256, createHash('sha256').update(bytes).digest('hex'))
    await verifyBackup(join(transaction, 'backup'), plan.description.scope.writes, plan.original)
  }
  if (remaining.shared.status === 'ready') {
    const ready = JSON.parse(await fs.readFile(join(dataDir, 'agent/shared-request-upgrade.json'), 'utf8'))
    const transaction = join(dataDir, ready.transaction), plan = JSON.parse(await fs.readFile(join(transaction, 'plan.json'), 'utf8'))
    // This fresh fixture has no old request transaction to preserve.
    assert.equal(plan.schema_version, 2)
    await verifyBackup(join(transaction, 'backup'), plan.write_scope, plan.backup_manifest)
  }
  assert.equal((await verifyCoreRelease(one.coreRoot)).version, one.version)
  assert.equal((await verifyCoreRelease(two.coreRoot)).version, two.version)
  updateComplete = true
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, from: one.version, to: two.version,
    target_bundled_node: true, actual_cli_upgrade_command: cliCommand, synthetic_previous_release: cliCommand, full_archive_download_checksum_extract: Boolean(archiveArgument), native_command_selected_target: true, common_migration_receipts_verified: true, duplicate_outer_backup: false,
    stable_agent_and_mcp_python_preserved: true, workspaces_preserved: true, immutable_payloads_verified: true,
    no_mm_started: true, health_verified: false }))
} finally {
  if (disk) {
    const sample = { phase: updateComplete ? 'cli-update-completed' : 'cli-update-interrupted', ...await disk.stop() }
    console.log('CRABOT_CLI_UPDATE_DISK ' + JSON.stringify(sample))
    const evidence = new URL('../../.desktop-build/', import.meta.url)
    await fs.mkdir(evidence, { recursive: true })
    await fs.writeFile(new URL('cli-update-disk.json', evidence), JSON.stringify(sample) + '\n')
  }
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
