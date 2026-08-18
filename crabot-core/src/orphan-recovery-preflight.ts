import path from 'node:path'
import { homedir } from 'node:os'
import { ModuleRuntimeRegistry } from './module-runtime-registry.js'
import { createOrphanTerminationConfirmer } from './orphan-recovery-prompt.js'

const portOffset = Number.parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const dataDir = process.env.DATA_DIR
  || path.join(homedir(), '.crabot', portOffset > 0 ? `data-${portOffset}` : 'data')

async function main(): Promise<void> {
  const registry = new ModuleRuntimeRegistry(dataDir, {
    confirmOrphanTermination: createOrphanTerminationConfirmer(),
  })
  await registry.initialize()
  await registry.recoverOrphans({
    currentRuntimeIds: new Set(),
    gracefulTimeoutMs: 30_000,
  })
}

main().catch((error) => {
  console.error(`[crabot] startup orphan recovery failed:\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
