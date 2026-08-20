/**
 * CliEventChannel — CLI hook 事件文件通道(通知三段式的中段)。
 *
 * claude code 的 Stop/Notification hook、codex 的 notify 会执行 hookCommand(kind)
 * 产出的 shell 片段,往事件文件追加一行 JSON;harness 侧用 watch()/readAll() 消费。
 * 与 P1 harness 亲历的 events.jsonl 分开命名(events-cli.jsonl),避免混淆。
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { watch as fsWatch, type FSWatcher } from 'fs'

export interface CliEvent {
  ts: string
  kind: 'stop' | 'notification' | 'session_start' | string
  raw: unknown
}

// POSIX shell 单引号转义:结束引号、插入一个已转义的单引号、重新开始引号。
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** POSIX shell 双引号内的转义(用于 `"${VAR:-<默认值>}"` 里的默认值部分)。 */
function dqEscape(s: string): string {
  return s.replace(/([\\"$`])/g, '\\$1')
}

/**
 * hook 运行时的事件文件重定向变量。设了且非空 → 事件写它,否则写 hookCommand 生成时
 * baked 进去的默认路径。
 *
 * 存在的理由:事件文件是 **workspace 级**的(`<ws>/.claude/events-cli.jsonl`),hook 配置
 * 同样是 workspace 级的(`.claude/settings.json`),而 cc 的 hooks 在无头 print 模式
 * (`claude -p`,即 fork 侧问的底座)同样执行——侧问收尾会往主线正在用的那份事件文件追加
 * 一条 stop,主线的 stop 计数被污染:跑到一半被判 idle 推假唤醒,真跑完那一轮反而因为
 * "状态没变"被整条吞掉。侧问按设计就是在主线还在跑的时候发起的,这不是罕见时序。
 *
 * 治本的做法是让侧问那个进程根本不写共享文件:调用方(ClaudeCodeAdapter.fork)给子进程的
 * env 塞一个私有路径,cc 拉起 hook 子进程时原样继承下去,hook 就写到私有文件里。交互态
 * (tmux pane)不设这个变量,照旧写共享文件。
 */
export const EVENTS_FILE_ENV = 'CRABOT_CLI_EVENTS_FILE'

const POLL_INTERVAL_MS = 2000

export class CliEventChannel {
  constructor(private filePath: string) {}

  /**
   * 返回当前文件末尾。调用方在启动一个新的 CLI 化身前记住该位置，再由 watch() 从这里
   * 接续，就不会把同 workspace 历史化身留下的 hook 当成本化身的新事件。
   */
  async endOffset(): Promise<number> {
    try {
      return (await fs.stat(this.filePath)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }

  /**
   * 生成供 CLI hook 使用的 shell 片段(POSIX sh,不依赖 node/jq 等非必装工具)。
   * 只用 printf + date -u 拼一行 JSON 并追加到事件文件。
   *
   * hook 的 stdin 是 CLI 提供的 JSON object payload。它只作为 JSON 值写进 raw，绝不执行、
   * 解释或重编码；去掉 CR/LF 仅用于把格式化 JSON 收束为单行（JSON 字符串里的换行必为
   * `\\n` 转义，因而不会被改变）。空、非 object 或明显截断的 stdin 降级为 legacy
   * `raw:null`。外形完整但内部无效的 object 无法靠纯 POSIX shell 完整验证；readAll/watch
   * 会识别本命令生成的可信 envelope，保留 ts/kind 并把这类 raw 同样降级为 null。
   *
   * 追加目标是 `"${CRABOT_CLI_EVENTS_FILE:-<本 channel 的路径>}"`——运行时可被调用方经
   * env 重定向到私有文件,见 EVENTS_FILE_ENV 注释。
   */
  hookCommand(kind: string): string {
    // kind 在生成时(而非 hook 运行时)就已知,这里直接做一次 JSON 字符串转义,
    // 再整体当作单个 shell 单引号字面量传给 printf 的 %s——避免 kind 内容
    // 里出现 % 之类字符被 printf 误当格式指令解析。
    const kindJsonEscaped = JSON.stringify(kind).slice(1, -1)
    const format = '{"ts":"%s","kind":"%s","source":"crabot_cli_hook","raw":%s}\\n'
    const target = `"\${${EVENTS_FILE_ENV}:-${dqEscape(this.filePath)}}"`
    const raw = "raw=$(tr -d '\\r\\n'); case \"$raw\" in \\{*\\}) ;; *) raw=null ;; esac"
    return [
      'ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
      raw,
      `printf '${format}' "$ts" ${shQuote(kindJsonEscaped)} "$raw" >> ${target}`,
    ].join('; ')
  }

  async readAll(): Promise<CliEvent[]> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const events: CliEvent[] = []
    for (const line of text.split('\n')) {
      const event = parseLine(line)
      if (event) events.push(event)
    }
    return events
  }

  /**
   * 监视事件文件的新增行:fs.watch(目录)作为快路径 + 2s 轮询兜底。
   * 按已读字节 offset 去重;文件/目录此时可能尚不存在,容忍并等待其出现。
   * 坏行(完整换行终结但内容损坏)默认跳过且不中断；由 hookCommand 生成、仅 raw payload
   * 损坏的可信 envelope 则保留 ts/kind 并降级为 raw:null。半行(尚无换行符,写入未完成)
   * 留到下次补全读——offset 只推进到最后一个完整换行处。
   */
  watch(
    onEvent: (e: CliEvent) => void | Promise<void>,
    options: { offset?: number } = {},
  ): () => Promise<void> {
    let stopped = false
    let offset = options.offset ?? 0
    let watcher: FSWatcher | null = null
    let pumpPromise: Promise<void> | null = null
    let disposePromise: Promise<void> | null = null

    const dir = path.dirname(this.filePath)
    const base = path.basename(this.filePath)

    const runPump = async () => {
      let stat
      try {
        stat = await fs.stat(this.filePath)
      } catch {
        return // 文件尚不存在,等下一次触发
      }
      if (stat.size <= offset) return

      const fd = await fs.open(this.filePath, 'r')
      let completeLines: string[]
      try {
        const len = stat.size - offset
        const buffer = Buffer.alloc(len)
        await fd.read(buffer, 0, len, offset)
        const text = buffer.toString('utf-8')
        const lines = text.split('\n')
        // 最后一段要么是空串(文本以 \n 结尾),要么是尚未写完的半行——
        // 两种情况都不当作"完整行"处理,offset 也不为它推进。
        completeLines = lines.slice(0, -1)
      } finally {
        await fd.close()
      }

      let consumedBytes = 0
      for (const line of completeLines) {
        consumedBytes += Buffer.byteLength(line, 'utf-8') + 1 // +1 for '\n'
        if (stopped) break
        const event = parseLine(line)
        if (event) await onEvent(event)
      }
      offset += consumedBytes
    }

    const pump = (): Promise<void> => {
      if (stopped) return Promise.resolve()
      if (pumpPromise) return pumpPromise
      pumpPromise = runPump().finally(() => { pumpPromise = null })
      return pumpPromise
    }

    const trySetupWatcher = () => {
      if (watcher || stopped) return
      try {
        const w = fsWatch(dir, (_eventType, filename) => {
          if (stopped) return
          if (!filename || filename === base) void pump()
        })
        w.on('error', () => {
          // 目录可能被删除/重建等导致 watcher 失效,回退到轮询兜底,下次轮询会重试建立。
          if (watcher === w) watcher = null
        })
        watcher = w
      } catch {
        // 目录此时可能还不存在,fs.watch 会抛错;轮询兜底会在目录出现后重试。
      }
    }

    trySetupWatcher()
    void pump() // 文件可能已有历史内容,立即读一次

    const interval = setInterval(() => {
      if (stopped) return
      trySetupWatcher()
      void pump()
    }, POLL_INTERVAL_MS)

    return () => {
      if (disposePromise) return disposePromise
      stopped = true
      clearInterval(interval)
      if (watcher) {
        watcher.close()
        watcher = null
      }
      disposePromise = pumpPromise ?? Promise.resolve()
      return disposePromise
    }
  }
}

function parseLine(line: string): CliEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'string' && typeof parsed.kind === 'string') {
      return { ts: parsed.ts, kind: parsed.kind, raw: 'raw' in parsed ? parsed.raw : null }
    }
    return null
  } catch {
    // hookCommand 的 ts/kind/source 前缀与末尾换行由我们生成，只有 raw 来自 CLI stdin。
    // POSIX shell 无法在不依赖 jq/node 的前提下完整校验任意 JSON；若 payload 外形像 object
    // 但内部损坏，带固定 source discriminator 的本通道 envelope 仍保留 turn/notification
    // 事件，仅把 raw 降级为 null。没有 discriminator 的其它坏行继续跳过。
    const envelope = /^\{"ts":"([^"\\]*)","kind":"((?:\\.|[^"\\])*)","source":"crabot_cli_hook","raw":.*\}$/.exec(trimmed)
    if (!envelope) return null
    try {
      const kind = JSON.parse(`"${envelope[2]}"`)
      return typeof kind === 'string' ? { ts: envelope[1], kind, raw: null } : null
    } catch {
      return null
    }
  }
}
