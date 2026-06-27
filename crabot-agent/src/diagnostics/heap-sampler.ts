import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import { getAgentLogsDir } from '../core/data-paths.js'

type ExtrasProvider = () => Record<string, unknown>

const MB = 1024 * 1024
const toMb = (bytes: number): number => Math.round((bytes / MB) * 100) / 100

interface SamplerHandle {
  stop: () => void
}

interface StartOptions {
  intervalMs?: number
  highWaterRatio?: number
  getExtras?: ExtrasProvider
}

export function startHeapSampler(opts: StartOptions = {}): SamplerHandle {
  const intervalMs = opts.intervalMs ?? 30_000
  const highWaterRatio = opts.highWaterRatio ?? 0.8
  const logDir = getAgentLogsDir()
  const logPath = path.join(logDir, 'heap-stats.log')

  try {
    fs.mkdirSync(logDir, { recursive: true })
  } catch {
    // ignore — sampler 不能挡进程启动
  }

  const writeLine = (kind: string, extras: Record<string, unknown> = {}): void => {
    const mem = process.memoryUsage()
    const heap = v8.getHeapStatistics()
    const record = {
      ts: new Date().toISOString(),
      kind,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      rss_mb: toMb(mem.rss),
      heap_used_mb: toMb(mem.heapUsed),
      heap_total_mb: toMb(mem.heapTotal),
      external_mb: toMb(mem.external),
      array_buffers_mb: toMb(mem.arrayBuffers),
      heap_size_limit_mb: toMb(heap.heap_size_limit),
      total_heap_size_mb: toMb(heap.total_heap_size),
      used_heap_size_mb: toMb(heap.used_heap_size),
      malloced_memory_mb: toMb(heap.malloced_memory),
      peak_malloced_memory_mb: toMb(heap.peak_malloced_memory),
      num_native_contexts: heap.number_of_native_contexts,
      num_detached_contexts: heap.number_of_detached_contexts,
      ...extras,
    }
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf-8')
    } catch {
      // ignore — 写盘失败别打断业务
    }
  }

  writeLine('session_start', {
    node_version: process.version,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
  })

  let lastHighWaterBytes = 0
  const interval = setInterval(() => {
    let extras: Record<string, unknown> = {}
    if (opts.getExtras) {
      try {
        extras = opts.getExtras()
      } catch {
        // ignore
      }
    }
    writeLine('sample', extras)

    const heap = v8.getHeapStatistics()
    const ratio = heap.used_heap_size / heap.heap_size_limit
    if (ratio > highWaterRatio && heap.used_heap_size > lastHighWaterBytes) {
      lastHighWaterBytes = heap.used_heap_size
      writeLine('high_water', { ratio: Math.round(ratio * 1000) / 1000, ...extras })
    }
  }, intervalMs)

  interval.unref?.()

  return {
    stop: (): void => {
      clearInterval(interval)
    },
  }
}
