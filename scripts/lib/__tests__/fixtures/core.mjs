// A local test child, never a Crabot instance. No modules, models or production data.
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  writeFileSync(process.env.TEST_MARKER, 'graceful')
  setTimeout(() => process.exit(0), Number(process.env.TEST_STOP_DELAY || 100))
}
process.on('message', message => {
  if (message?.type === 'crabot-shutdown' && message.generation === process.env.CRABOT_INSTANCE_GENERATION) stop()
})
createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    if (request.url === '/shutdown') {
      const input = JSON.parse(body)
      const valid = input.params?.expected_generation === process.env.CRABOT_INSTANCE_GENERATION
      response.writeHead(valid ? 200 : 409).end(JSON.stringify({ success: valid }))
      if (valid) stop()
    } else response.end(JSON.stringify({ success: true }))
  })
}).listen(Number(process.env.TEST_PORT), '127.0.0.1', () => writeFileSync(process.env.TEST_READY, 'ready'))
