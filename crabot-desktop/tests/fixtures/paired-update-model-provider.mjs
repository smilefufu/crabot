// Local metadata fixture only. Generation is explicitly unavailable; this is
// independent of both GUI processes so source exit cannot kill the listener.
import { createServer } from 'node:http'
import { once } from 'node:events'
export async function startPairedUpdateModelProvider() {
  const evidence = { metadata_requests: 0, generation_requests: 0, unexpected_requests: 0 }
  const server = createServer((req, res) => {
    req.resume(); res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && req.url === '/v1/models') {
      evidence.metadata_requests++
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'desktop-paired-update', object: 'model', owned_by: 'isolated-fixture' }] })); return
    }
    if (req.method === 'POST' && ['/v1/chat/completions', '/v1/completions', '/v1/responses'].includes(req.url)) {
      evidence.generation_requests++
      res.writeHead(503).end(JSON.stringify({ error: { message: 'Generation is disabled in the paired update fixture', type: 'fixture_unavailable' } })); return
    }
    evidence.unexpected_requests++; res.writeHead(404).end('{}')
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', evidence,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }) }
}
