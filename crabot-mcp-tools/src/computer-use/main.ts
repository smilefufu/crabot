import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createComputerUseServer } from './server.js'

async function main() {
  const server = createComputerUseServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`Computer Use MCP server failed: ${err}\n`)
  process.exit(1)
})
