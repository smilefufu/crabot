// Bundled with production tool implementations; this process only runs inside Docker.
import { createReadTool } from '../../src/engine/tools/read-tool'
import { createEditTool } from '../../src/engine/tools/edit-tool'
import { createWriteTool } from '../../src/engine/tools/write-tool'
import { createBashTool } from '../../src/engine/tools/bash-tool'
import { checkToolPermission } from '../../src/engine/permission-checker'
import { createGuidanceTool } from '../../src/guidance/catalog'

const tools = [createReadTool, createEditTool, createWriteTool, createBashTool].map(make => make(() => '/fixture'))
tools.push(createGuidanceTool('worker'))
async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input)
  const tool = tools.find(item => item.name === request.name)
  if (!tool) throw new Error(`Unknown tool: ${request.name}`)
  const permission = await checkToolPermission(tool.name, request.input, tool, request.permission)
  const result = permission.allowed
    ? await tool.call(request.input, { abortSignal: AbortSignal.timeout(30000) })
    : { isError: true, output: permission.reason }
  process.stdout.write(JSON.stringify({ permission, result }) + '\n')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
