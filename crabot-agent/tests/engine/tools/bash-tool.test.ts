import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createBashTool,
  MAX_FOREGROUND_TIMEOUT_MS,
  FOREGROUND_GRACE_PERIOD_MS,
} from '../../../src/engine/tools/bash-tool'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import type { BashBgContext } from '../../../src/engine/tools/bash-tool'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { ToolCallContext } from '../../../src/engine/types'

describe('createBashTool', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
  const tool = createBashTool(() => tmpDir)

  it('returns ToolDefinition with correct name and schema', () => {
    expect(tool.name).toBe('Bash')
    expect(tool.isReadOnly).toBe(false)
    expect(tool.permissionLevel).toBe('dangerous')
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    })
    // run_in_background / timeout 参数已移除（后台与否由 10s 宽限期自动决定）
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties
    expect(props.run_in_background).toBeUndefined()
    expect(props.timeout).toBeUndefined()
  })

  it('executes simple command', async () => {
    const result = await tool.call({ command: 'echo hello' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  })

  it('formats stdout and stderr with exit_code fields', async () => {
    const result = await tool.call({ command: 'printf "out"; printf "err" >&2' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('exit_code: 0')
    expect(result.output).toContain('stdout:\nout')
    expect(result.output).toContain('stderr:\nerr')
  })

  it('returns command result for non-zero exit without tool error', async () => {
    const result = await tool.call({ command: 'printf "out"; printf "err" >&2; exit 1' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('exit_code: 1')
    expect(result.output).toContain('stdout:\nout')
    expect(result.output).toContain('stderr:\nerr')
  })

  it('respects cwd', async () => {
    const result = await tool.call({ command: 'pwd' }, {})
    expect(result.isError).toBe(false)
    // Resolve symlinks (macOS /tmp -> /private/tmp)
    const resolvedTmpDir = fs.realpathSync(tmpDir)
    expect(result.output).toContain('exit_code: 0')
    expect(result.output).toContain(`stdout:\n${resolvedTmpDir}`)
  })

  it('returns a tool error when cwd is missing', async () => {
    const missingCwd = path.join(tmpDir, 'missing-cwd')
    const missingTool = createBashTool(() => missingCwd)

    const result = await missingTool.call({ command: 'echo hi' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/Command execution failed|ENOENT/)
  })

  it('respects abort signal', async () => {
    const controller = new AbortController()
    // Abort immediately
    controller.abort()

    const context: ToolCallContext = { abortSignal: controller.signal }
    const result = await tool.call({ command: 'sleep 10' }, context)
    expect(result.isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 输出截断：>50K 保留尾部 + 完整 stdout/stderr 落盘 tmp/tool-outputs/，
// 返回文本附全文路径；≤50K 行为不变、不落盘。
// ---------------------------------------------------------------------------

describe('createBashTool — 输出截断与全文落盘', () => {
  let tmpDataDir: string
  let tool: ReturnType<typeof createBashTool>
  const cwd = os.tmpdir()

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-trunc-test-'))
    // 落盘目录从 CRABOT_AGENT_DATA_DIR 推导（优先级高于 DATA_DIR）
    process.env.CRABOT_AGENT_DATA_DIR = tmpDataDir
    tool = createBashTool(() => cwd)
  })

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    delete process.env.CRABOT_AGENT_DATA_DIR
  })

  it('>50K 输出：保留尾部，全文落盘且路径出现在返回文本中', async () => {
    const result = await tool.call(
      { command: `echo HEAD_MARKER; printf 'x%.0s' {1..60000}; echo; echo TAIL_MARKER` },
      {} as ToolCallContext,
    )
    expect(result.isError).toBe(false)
    // 尾部保留：结尾的标记在，开头的标记被截掉
    expect(result.output).toContain('TAIL_MARKER')
    expect(result.output).not.toContain('HEAD_MARKER')
    expect(result.output).toContain('[Showing last')
    expect(result.output).toContain('bytes of')

    // 返回文本带全文路径，落盘文件包含被截掉的头部
    const match = result.output.match(/Full output: ([^\]]+)\]/)
    expect(match).not.toBeNull()
    const fullPath = match![1]
    expect(fullPath.startsWith(path.join(tmpDataDir, 'tmp', 'tool-outputs'))).toBe(true)
    const full = fs.readFileSync(fullPath, 'utf8')
    expect(full).toContain('HEAD_MARKER')
    expect(full).toContain('TAIL_MARKER')
  })

  it('CJK 多字节输出：按字节截断（不切字符），自截产物恒 < 编排层 100KB 兜底', async () => {
    // 20000 个"中" = 60000 字节 > 50000 字节阈值；按字符口径会保留 ~150KB 字节
    const result = await tool.call(
      { command: `printf '中%.0s' {1..20000}; echo; echo CJK_TAIL` },
      {} as ToolCallContext,
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('CJK_TAIL')
    expect(result.output).toContain('[Showing last')
    // 尾部 hint 带落盘路径，且就在返回文本末尾（不会被编排层二次截断切掉）
    expect(result.output).toMatch(/Full output: [^\]]+\]\s*$/)
    // 不出现 UTF-8 截断产生的替换字符
    expect(result.output).not.toContain('�')
    // 关键不变量：自截产物字节数 < 编排层 100KB 兜底阈值
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(100 * 1024)
  })

  it('≤50K 输出：行为不变，不落盘', async () => {
    const result = await tool.call({ command: 'echo small-output' }, {} as ToolCallContext)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('small-output')
    expect(result.output).not.toContain('Full output:')
    expect(result.output).not.toContain('Showing last')
    expect(fs.existsSync(path.join(tmpDataDir, 'tmp', 'tool-outputs'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createBashTool with bgCtx：统一前台/后台模型
//   - 宽限期内结束 → inline 同步返回，不入 bgRegistry
//   - 超期仍在跑 → 转后台（注册 bgRegistry，命令不中断）+ 引导 wait_for_signal
//   - 转后台后退出 → onShellExit 触发（唤醒挂起 worker + 持久通知）
// ---------------------------------------------------------------------------

describe('createBashTool with bgCtx', () => {
  let tmpDataDir: string
  let registry: BgEntityRegistry
  const cwd = os.tmpdir()

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-bg-test-'))
    // bg-shell / registry 默认路径都从 DATA_DIR 推导
    process.env.DATA_DIR = tmpDataDir
    registry = new BgEntityRegistry()
  })

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    delete process.env.DATA_DIR
  })

  // 等 bg 命令真正退出（onShellExit 触发）后再断言
  const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms))

  type ExitInfo = Parameters<NonNullable<BashBgContext['onShellExit']>>[0]
  function makeBgCtx(taskId: string, onShellExit?: (info: ExitInfo) => void): BashBgContext {
    return {
      registry,
      owner: { friend_id: 'friend-master' },
      taskId,
      ...(onShellExit ? { onShellExit } : {}),
    }
  }

  it('MAX_FOREGROUND_TIMEOUT_MS constant is 600_000', () => {
    expect(MAX_FOREGROUND_TIMEOUT_MS).toBe(600_000)
  })

  it('FOREGROUND_GRACE_PERIOD_MS constant is 10_000', () => {
    expect(FOREGROUND_GRACE_PERIOD_MS).toBe(10_000)
  })

  it('synchronous path still works when bgCtx is provided', async () => {
    const tool = createBashTool(() => cwd, undefined, makeBgCtx('task-sync'))
    const result = await tool.call({ command: 'echo sync-ok' }, {} as ToolCallContext)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('sync-ok')
  })

  it('grace 快路径：命令在宽限期内完成 → 同步内联返回，不残留进 bgRegistry', async () => {
    const tool = createBashTool(() => cwd, undefined, makeBgCtx('task-grace-fast'))
    const result = await tool.call({ command: 'echo grace-fast' }, {} as ToolCallContext)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('grace-fast')
    expect(result.output).not.toContain('转入后台')
    // 宽限期内结束 → 不入账
    const all = await registry.list()
    expect(all.filter((e) => e.spawned_by_task_id === 'task-grace-fast')).toHaveLength(0)
  })

  it('grace 快路径：非零退出码是命令结果，不是 tool error', async () => {
    const tool = createBashTool(() => cwd, undefined, makeBgCtx('task-grace-fail'))
    const result = await tool.call(
      { command: 'printf "oops"; printf "bad" >&2; exit 3' },
      {} as ToolCallContext,
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('exit_code: 3')
    expect(result.output).toContain('stdout:\noops')
    expect(result.output).toContain('stderr:\nbad')
  })

  it('grace 慢路径：共享文案按工具表区分 wait_for_signal 与 blocking Output', async () => {
    const pushed: ExitInfo[] = []
    // 注入 50ms 短 grace，命令 sleep 0.4s 必然超期
    const tool = createBashTool(() => cwd, undefined, makeBgCtx('task-grace-slow', (info) => pushed.push(info)), 50)

    const result = await tool.call(
      { command: 'sleep 0.4 && echo slow-done' },
      {} as ToolCallContext,
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('转入后台继续运行')
    expect(result.output).toContain('工具列表中有 wait_for_signal')
    expect(result.output).toContain('工具列表中没有 wait_for_signal')
    expect(result.output).toContain('block=true')
    expect(result.output).toContain('timeout_ms=600000')
    expect(result.output).not.toContain('若没有，调 wait_for_signal')
    expect(result.output).not.toContain('exit_code:')
    const match = result.output.match(/shell_[0-9a-f]+/)
    expect(match).not.toBeNull()
    const shellId = match![0]

    // 转后台即注册进 bgRegistry，状态 running（此刻命令仍在 sleep）
    const rec = await registry.get(shellId)
    expect(rec).not.toBeNull()
    expect(rec?.type).toBe('shell')
    expect(rec?.spawned_by_task_id).toBe('task-grace-slow')
    expect(rec?.status).toBe('running')

    // 命令真正退出 → onShellExit 触发 + registry 标 completed
    await settle(1200)
    expect(pushed.map((i) => i.entity_id)).toContain(shellId)
    expect(pushed.find((i) => i.entity_id === shellId)?.status).toBe('completed')
    const rec2 = await registry.get(shellId)
    expect(rec2?.status).toBe('completed')
    expect(rec2?.exit_code).toBe(0)
  })

  it('无 bgCtx（legacy/sub-agent）：退回旧同步前台执行', async () => {
    const tool = createBashTool(() => cwd) // 没传 bgCtx
    const result = await tool.call({ command: 'echo legacy-sync' }, {} as ToolCallContext)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('legacy-sync')
    expect(result.output).not.toContain('转入后台')
  })
})
