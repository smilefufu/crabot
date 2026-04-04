import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createGitServer } from './server.js'

async function main() {
  const cwd = process.argv[2] || process.cwd()
  const server = createGitServer(cwd)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`Git MCP server failed: ${err}\n`)
  process.exit(1)
})
