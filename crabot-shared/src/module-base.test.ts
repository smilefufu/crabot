import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  RpcClient,
  RpcCallError,
  RpcError,
  formatHandlerError,
  rpcErrorHttpStatus,
  isSensitiveRpcCall,
  type SensitiveRpcMethod,
  type TraceStoreInterface,
} from './module-base.js'

const SENSITIVE_METHODS: SensitiveRpcMethod[] = [
  'get_agent_config',
  'resolve_worker_connection',
  'verify_core_agent_runtime',
  'complete_core_agent_cutover',
  'register_core_agent',
  'consume_admin_chat_assertion',
  'consume_worker_operation_assertion',
  'process_message',
  'install_worker_implementation',
  'start_worker_implementation_setup',
  'verify_worker_implementation',
  'cancel_worker_implementation_operation',
  'attach_worker_implementation_setup_stream',
]

test('authentication errors preserve RPC codes and map to HTTP 401/403', () => {
  for (const ErrorType of [RpcError, RpcCallError]) {
    for (const [code, status] of [['UNAUTHORIZED', 401], ['FORBIDDEN', 403]] as const) {
      const error = new ErrorType(code, `expected ${code}`)
      const response = formatHandlerError(error, 'request')
      assert.equal(response.success, false)
      assert.equal(response.error?.code, code)
      assert.equal(rpcErrorHttpStatus(error), status)
    }
  }
  assert.equal(rpcErrorHttpStatus(new Error('ordinary failure')), 500)
})

test('sensitive RPC classifier requires no-trace transport', () => {
  for (const method of SENSITIVE_METHODS) {
    const params = method === 'process_message' ? { source_type: 'admin_chat' } : {}
    assert.equal(isSensitiveRpcCall(method, params), true, method)
  }
})

test('ordinary Channel process_message remains non-sensitive', () => {
  assert.equal(isSensitiveRpcCall('process_message', { source_type: 'channel' }), false)
  assert.equal(isSensitiveRpcCall('health', {}), false)
})

test('ordinary call rejects a sensitive method before network I/O or trace creation', async () => {
  const traces: TraceStoreInterface = {
    startSpan: () => { throw new Error('trace must not start') },
    endSpan: () => { throw new Error('trace must not end') },
  }
  const client = new RpcClient()
  await assert.rejects(
    client.call(1, 'get_agent_config', { instance_id: 'crabot-agent' }, 'test', {
      traceStore: traces,
      traceId: 'trace-secret',
    }),
    (error: unknown) => (error as { code?: string }).code === 'SENSITIVE_RPC_REQUIRES_NO_TRACE_TRANSPORT',
  )
})

test('callSensitive rejects methods outside the sensitive closure before network I/O', async () => {
  const client = new RpcClient()
  await assert.rejects(
    client.callSensitive(1, 'health' as SensitiveRpcMethod, {}, 'test'),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_SENSITIVE_RPC_METHOD',
  )
  await assert.rejects(
    client.callSensitive(1, 'process_message', { source_type: 'channel' }, 'test'),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_SENSITIVE_RPC_METHOD',
  )
})

test('callSensitive puts bearer only in Authorization and never creates a trace span', async () => {
  const bearer = 'wire-bearer-marker-7f3bc89a'
  const responseSecret = 'response-secret-marker-b96fd470'
  let capturedBody = ''
  let capturedAuthorization: string | undefined
  const server = http.createServer((req, res) => {
    capturedAuthorization = req.headers.authorization
    req.setEncoding('utf8')
    req.on('data', (chunk) => { capturedBody += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'response', success: true, data: { connection: responseSecret }, timestamp: new Date().toISOString() }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const result = await new RpcClient().callSensitive(
      address.port,
      'get_agent_config',
      { instance_id: 'crabot-agent' },
      'forged-audit-source',
      { authorizationBearer: bearer },
    )
    assert.deepEqual(result, { connection: responseSecret })
    assert.equal(capturedAuthorization, `Bearer ${bearer}`)
    assert.equal(capturedBody.includes(bearer), false)
    assert.equal(capturedBody.includes('forged-audit-source'), true)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('concurrent sensitive calls keep transport bearers request-scoped', async () => {
  const seen = new Map<string, string | undefined>()
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const request = JSON.parse(body) as { params: { request_id: string } }
      seen.set(request.params.request_id, req.headers.authorization)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: request.params.request_id, success: true, data: { ok: true }, timestamp: new Date().toISOString() }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const client = new RpcClient()
    await Promise.all([
      client.callSensitive(address.port, 'verify_core_agent_runtime', { request_id: 'one' }, 'test', { authorizationBearer: 'token-one' }),
      client.callSensitive(address.port, 'verify_core_agent_runtime', { request_id: 'two' }, 'test', { authorizationBearer: 'token-two' }),
    ])
    assert.equal(seen.get('one'), 'Bearer token-one')
    assert.equal(seen.get('two'), 'Bearer token-two')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
