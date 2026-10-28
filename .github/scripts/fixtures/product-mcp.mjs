import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (!('id' in request)) continue
  let result
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'product-probe', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: [{ name: 'runtime', description: 'Local runtime verification', inputSchema: { type: 'object', properties: {} } }] }
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({
    node: process.execPath,
    python: execFileSync('python3', ['-I', '-X', 'utf8', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(),
    npm_cache: process.env.npm_config_cache,
    uv_cache: process.env.UV_CACHE_DIR,
    secret_inherited: Boolean(process.env.CRABOT_JWT_SECRET || process.env.UNRELATED_SECRET),
  }) }] }
  else result = {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
