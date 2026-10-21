// Only executed inside the isolated fixture container, never on the host.
import { getAllBuiltinTools } from '../../src/engine/tools/index'

const tools = getAllBuiltinTools(() => '/fixture/project', {
  availableSkills: [{ name: 'tmp-page', description: '创建供人类查看或交互反馈的临时页面', skill_dir: '/fixture/skills/tmp-page' }],
})
async function main() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const request = JSON.parse(text)
  const tool = tools.find(t => t.name === request.name)
  if (!tool) throw new Error(`FIXTURE_GAP: unsupported tool ${request.name}`)
  const result = await tool.call(request.input, { abortSignal: AbortSignal.timeout(30000) })
  process.stdout.write(JSON.stringify({ result }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
