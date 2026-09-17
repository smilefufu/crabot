// Bundled with production tool implementations; this process only runs inside Docker.
import { createReadTool } from '../../src/engine/tools/read-tool'
import { createEditTool } from '../../src/engine/tools/edit-tool'
import { createWriteTool } from '../../src/engine/tools/write-tool'
import { createBashTool } from '../../src/engine/tools/bash-tool'
import { checkToolPermission } from '../../src/engine/permission-checker'
import { buildProjectDocTools } from '../../src/manager/tools/project-doc-tools'
import { createGuidanceTool } from '../../src/guidance/catalog'

const tools = [createReadTool, createEditTool, createWriteTool, createBashTool].map(make => make(() => '/fixture'))
tools.push(createGuidanceTool('worker'))
async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input)
  if (request.projectContext) {
    const { workers, contexts, ...deps } = request.projectContext
    tools.push(...buildProjectDocTools({ ...deps,
      ledger: {
        listWorkers: async key => workers.filter(w => w.manager_key === key),
        findWorker: async id => { const worker = workers.find(w => w.worker_id === id); return worker ? { managerKey: worker.manager_key, worker } : null },
      },
      readWorkerContext: async id => contexts[id],
    }))
  }
  const tool = tools.find(item => item.name === request.name)
  if (!tool) throw new Error(`Unknown tool: ${request.name}`)
  const permission = await checkToolPermission(tool.name, request.input, tool, request.permission)
  const result = permission.allowed
    ? await tool.call(request.input, { abortSignal: AbortSignal.timeout(30000) })
    : { isError: true, output: permission.reason }
  process.stdout.write(JSON.stringify({ permission, result }) + '\n')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
