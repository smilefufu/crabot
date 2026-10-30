import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Three real, finite module processes exit while their schema-1 records remain.
export async function stoppedLegacyModules(dataDir) {
  const directory = path.join(dataDir, 'module-runtime-registry'), records = path.join(directory, 'records'), instanceId = randomUUID()
  await fs.mkdir(records, { recursive: true })
  await fs.writeFile(path.join(directory, 'instance-id'), instanceId + '\n')
  const script = `import net from 'node:net';import{once}from'node:events';import{probeProcessStartIdentity}from ${JSON.stringify(new URL('../../module-process-start.cjs', import.meta.url).href)};const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');console.log(JSON.stringify({pid:process.pid,start:await probeProcessStartIdentity(process.pid),port:s.address().port}));s.close()`
  const files = []
  for (const moduleId of ['crabot-agent', 'admin-web', 'memory-default']) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 15_000 })
    const old = JSON.parse(stdout), runtimeId = randomUUID()
    const file = path.join(records, runtimeId + '.json'), record = { schema_version: 1, instance_id: instanceId, runtime_id: runtimeId,
      module_id: moduleId, root_pid: old.pid, process_start_identity: old.start, module_port: old.port, created_at: new Date().toISOString() }
    await fs.writeFile(file, JSON.stringify(record)); files.push(file)
    await fs.writeFile(path.join(dataDir, 'mm.pid'), String(old.pid))
  }
  return { records, files, instanceId }
}
