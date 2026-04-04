import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createLspServer } from './server.js'

async function main() {
  const cwd = process.argv[2] || process.cwd()
  const { server, stopAll } = createLspServer(cwd)
  const transport = new StdioServerTransport()

  process.on('SIGINT', async () => { await stopAll(); process.exit(0) })
  process.on('SIGTERM', async () => { await stopAll(); process.exit(0) })

  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`LSP MCP server failed: ${err}\n`)
  process.exit(1)
})
