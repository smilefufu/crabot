import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.resolve(import.meta.dirname, '../../package.json'))
const context = new AsyncLocalStorage()
const installed = new WeakSet()

export function installDockerProjectDocs(sourceRoot) {
  const req = sourceRoot ? createRequire(path.join(sourceRoot, 'crabot-agent/package.json')) : require
  const module = req('./dist/manager/tools/project-doc-tools.js')
  if (installed.has(module)) return
  installed.add(module)
  const original = module.buildProjectDocTools

  // Eval-process-only transport: preserve product authorization and Markdown handling,
  // but evaluate filesystem paths in the container namespace used by the Worker tools.
  module.buildProjectDocTools = deps => {
    const fixture = context.getStore()
    const tools = original(deps)
    if (!fixture) return tools
    return tools.map(tool => ({ ...tool, async call(input) {
      const workers = await deps.ledger.listWorkers(deps.managerKey)
      const contexts = Object.fromEntries(await Promise.all(workers.map(async worker =>
        [worker.worker_id, await deps.readWorkerContext(worker.worker_id)])))
      const roots = new Set(workers.flatMap(worker => worker.incarnations.map(i => i.workspace)))
      const projectContext = { ...deps, ledger: undefined, readWorkerContext: undefined,
        workers: workers.map(worker => ({ ...worker, incarnations: worker.incarnations.map(i => ({ ...i, workspace: '/fixture' })) })), contexts }
      const actual = { ...input, project_root: roots.has(input.project_root) ? '/fixture' : input.project_root }
      const receipt = await fixture.box.call(tool.name, actual, { mode: 'bypass' }, projectContext)
      fixture.emit({ type: 'executed_tool', role: 'manager', name: tool.name, input, receipt })
      return receipt.result
    } }))
  }

}
installDockerProjectDocs()

export const withDockerProjectDocs = (box, emit, run) => context.run({ box, emit }, run)
