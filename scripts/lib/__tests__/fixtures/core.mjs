// A local test child, never a Crabot instance. No modules, models or production data.
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
// A failed fixture setup must not leave its fake HTTP server holding test pipes.
process.once('disconnect', () => process.exit(0))
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  writeFileSync(process.env.TEST_MARKER, 'graceful')
  const delay = Number(process.env.TEST_STOP_DELAY || 100)
  console.log('FIXTURE_SHUTDOWN ' + JSON.stringify({ delay_ms: delay }))
  setTimeout(() => process.exit(0), delay)
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
    } else if (request.url === '/list_modules') {
      response.end(JSON.stringify({ success: true, data: { modules: [{ module_id: 'admin-web', status: 'running', port: 23456 }] } }))
    } else response.end(JSON.stringify({ success: true, data: { status: process.env.TEST_HEALTH_STATUS || 'healthy' } }))
  })
}).listen(Number(process.env.TEST_PORT), '127.0.0.1', () => writeFileSync(process.env.TEST_READY, 'ready'))
