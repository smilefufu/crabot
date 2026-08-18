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
  'verify_worker_implementation',
  'cancel_worker_implementation_operation',
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
    assert.equal(rpcErrorHttpStatus(new ErrorType('SERVICE_UNAVAILABLE', 'unavailable')), 503)
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

// ── 代理配置持久化（启动即联网模块等不到注册后的推送）──

test('ModuleBase restores persisted proxy config at construction and persists updates', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { ModuleBase } = await import('./module-base.js')
  const { proxyManager } = await import('./proxy-manager.js')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-proxy-persist-'))
  process.env.DATA_DIR = dir

  class ProbeModule extends ModuleBase {
    protected async onStart(): Promise<void> {}
    protected async onStop(): Promise<void> {}
    exposeHandler(name: string): ((params: unknown) => unknown) | undefined {
      return this.methodHandlers.get(name) as ((params: unknown) => unknown) | undefined
    }
  }

  const baseConfig = {
    moduleId: 'probe-1',
    moduleType: 'probe',
    version: '0.0.1',
    protocolVersion: '0.0.1',
    port: 0,
  }

  // 1) 无持久化记录 → system
  new ProbeModule(baseConfig)
  assert.equal((proxyManager as unknown as { config: { mode: string } }).config.mode, 'system')

  // 2) 推送 custom → 立即生效且落盘
  const mod = new ProbeModule(baseConfig)
  const handler = mod.exposeHandler('update_proxy_config')!
  const result = handler({ proxy: { mode: 'custom', custom_url: 'http://127.0.0.1:7890' } }) as { success: true }
  assert.equal(result.success, true)
  assert.equal((proxyManager as unknown as { config: { mode: string } }).config.mode, 'custom')
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'proxy-config.json'), 'utf-8'))
  assert.deepEqual(persisted, { mode: 'custom', custom_url: 'http://127.0.0.1:7890' })

  // 3) 新实例（模拟重启）构造即恢复 custom——不等推送
  new ProbeModule(baseConfig)
  const restored = (proxyManager as unknown as { config: { mode: string; custom_url?: string } }).config
  assert.equal(restored.mode, 'custom')
  assert.equal(restored.custom_url, 'http://127.0.0.1:7890')

  // 4) 损坏文件回退 system，不阻塞启动
  fs.writeFileSync(path.join(dir, 'proxy-config.json'), '{broken')
  new ProbeModule(baseConfig)
  assert.equal((proxyManager as unknown as { config: { mode: string } }).config.mode, 'system')

  delete process.env.DATA_DIR
  fs.rmSync(dir, { recursive: true, force: true })
})

test('shutdown starts cleanup immediately and repeated stop waits for the same cleanup', async () => {
  const { ModuleBase } = await import('./module-base.js')
  let startCleanup!: () => void
  let finishCleanup!: () => void
  const cleanupStarted = new Promise<void>((resolve) => { startCleanup = resolve })
  const cleanupFinished = new Promise<void>((resolve) => { finishCleanup = resolve })
  let onStopCalls = 0

  class ProbeModule extends ModuleBase {
    protected override async onStop(): Promise<void> {
      onStopCalls += 1
      startCleanup()
      await cleanupFinished
    }
    shutdownHandler(): () => Promise<unknown> {
      return this.methodHandlers.get('shutdown') as () => Promise<unknown>
    }
  }

  const mod = new ProbeModule({
    moduleId: 'shutdown-probe',
    moduleType: 'probe',
    version: '0.0.1',
    protocolVersion: '0.0.1',
    port: 0,
  })

  await mod.shutdownHandler()()
  await cleanupStarted
  assert.equal(onStopCalls, 1)

  let secondStopResolved = false
  const secondStop = mod.stop().then(() => { secondStopResolved = true })
  await Promise.resolve()
  assert.equal(secondStopResolved, false)

  finishCleanup()
  await secondStop
  assert.equal(onStopCalls, 1)
})

test('runtime identity probe returns only the MM-injected runtime identity', async () => {
  const { ModuleBase } = await import('./module-base.js')
  const previousInstanceId = process.env.CRABOT_INSTANCE_ID
  const previousRuntimeId = process.env.CRABOT_MODULE_RUNTIME_ID
  process.env.CRABOT_INSTANCE_ID = 'instance-test'
  process.env.CRABOT_MODULE_RUNTIME_ID = 'runtime-test'

  class ProbeModule extends ModuleBase {
    runtimeIdentityHandler(): () => Promise<unknown> {
      return this.methodHandlers.get('get_runtime_identity') as () => Promise<unknown>
    }
  }

  try {
    const mod = new ProbeModule({
      moduleId: 'probe-runtime',
      moduleType: 'probe',
      version: '0.0.1',
      protocolVersion: '0.0.1',
      port: 0,
    })
    assert.deepEqual(await mod.runtimeIdentityHandler()(), {
      instance_id: 'instance-test',
      module_id: 'probe-runtime',
      runtime_id: 'runtime-test',
    })
  } finally {
    if (previousInstanceId === undefined) delete process.env.CRABOT_INSTANCE_ID
    else process.env.CRABOT_INSTANCE_ID = previousInstanceId
    if (previousRuntimeId === undefined) delete process.env.CRABOT_MODULE_RUNTIME_ID
    else process.env.CRABOT_MODULE_RUNTIME_ID = previousRuntimeId
  }
})

test('runtime identity probe fails closed when MM identity is missing', async () => {
  const { ModuleBase } = await import('./module-base.js')
  const previousInstanceId = process.env.CRABOT_INSTANCE_ID
  const previousRuntimeId = process.env.CRABOT_MODULE_RUNTIME_ID
  delete process.env.CRABOT_INSTANCE_ID
  delete process.env.CRABOT_MODULE_RUNTIME_ID

  class ProbeModule extends ModuleBase {
    runtimeIdentityHandler(): () => Promise<unknown> {
      return this.methodHandlers.get('get_runtime_identity') as () => Promise<unknown>
    }
  }

  try {
    const mod = new ProbeModule({
      moduleId: 'probe-runtime',
      moduleType: 'probe',
      version: '0.0.1',
      protocolVersion: '0.0.1',
      port: 0,
    })
    await assert.rejects(
      mod.runtimeIdentityHandler()(),
      (error: unknown) => (error as { code?: string }).code === 'SERVICE_UNAVAILABLE',
    )
  } finally {
    if (previousInstanceId === undefined) delete process.env.CRABOT_INSTANCE_ID
    else process.env.CRABOT_INSTANCE_ID = previousInstanceId
    if (previousRuntimeId === undefined) delete process.env.CRABOT_MODULE_RUNTIME_ID
    else process.env.CRABOT_MODULE_RUNTIME_ID = previousRuntimeId
  }
})
