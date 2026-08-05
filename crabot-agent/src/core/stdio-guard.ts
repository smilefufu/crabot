/**
 * stdout / stderr 写失败的收口 —— 一处装上，覆盖全仓所有 `console.*` 调用点。
 *
 * ## 事故（2026-08-05 06:38:05Z）
 *
 * LLM 端点抖动 → `withStreamConsumptionRetry` 疯狂打重试日志 → MM 被 SIGTERM 后 stderr 管道
 * 读端关闭 → `console.error` 的写以 EPIPE 失败 → `main.ts` 的 `uncaughtException` 处理器把它
 * 转成 `process.exit(1)`。**一个记录故障的动作把进程杀了**：agent 死了 47 秒，重启时 reconcile
 * 判死两个在跑的化身，其中一条 cc 任务落终态 `failed`。
 *
 * ## 为什么这一处能收口（Node 22 实测，见 tests/core/stdio-guard.test.ts）
 *
 * 1. 管道的写失败**不是同步抛**的：`process.stdout/stderr` 在管道上是 `net.Socket`，errno 在
 *    `afterWriteDispatched` 里就地构造成 Error（所以它的栈末端仍是那句 `console.error`），
 *    再经 `destroy(err)` 在下一个 tick 以 **'error' 事件**派发。`console.error` 与
 *    `process.stderr.write()` 都不会 throw —— 在调用点包 try/catch 一次也抓不到。
 * 2. Node 的 `Console` 自带的防护**只挡得住第一条**：`kWriteToConsole` 的写回调里有
 *    `if (err !== null && !stream._writableState.errorEmitted) stream.once('error', noop)`。
 *    `errorEmitted` 是黏性的——第一次 EPIPE 被那个 noop 吃掉后它就永久为 true，**第二条及以后
 *    的日志**再失败时 Node 不再补挂 noop，'error' 事件落到零监听器上 → EventEmitter 直接
 *    throw → uncaughtException。这正是"平时崩不了、日志一刷屏就崩"的原因，也是事故当天
 *    重试风暴触发它的原因。
 * 3. 装一个**常驻**监听器同时堵死两头：'error' 永远有人接，不再 throw；且
 *    `listenerCount('error') > 0` 让 Console 那套"临时挂了又摘"的动作彻底不再参与。
 *
 * ## 为什么不筛错误码（只吞 EPIPE）
 *
 * 这个监听器上能收到的一切，按定义都是"日志出口本身写不出去"：既无处上报（要报也只能往
 * 同一个坏掉的出口写），也与进程正在做的事（RPC、落盘、台账）无关。只吞 EPIPE、其余 rethrow
 * 的写法不是更安全，而是把同一场崩溃原样搬到 EIO（控制终端消失，daemon 化后的典型形态）和
 * ERR_STREAM_DESTROYED 上——在 'error' 处理器里 rethrow 同样是 uncaughtException。
 * Node 自己的 `Console` 是同一取舍：同步写错误一律吞，只放行 stack overflow
 * （lib/internal/console/constructor.js 的 `kWriteToConsole`，注释写着 "Sorry, there's no
 * proper way to pass along the error here"）。
 *
 * 代价（如实记）：stdio 写失败从此完全不可见。可接受——它本来也只能通过写 stdio 来"可见"。
 * 进程真正的健康信号走 MM 的 health check 与 `data/agent/fatal.log`，不依赖这条通道。
 *
 * **不动 `main.ts` 的 `uncaughtException` → `exit(1)`**：那是最后防线，不该为这一种错误削弱它。
 */
export function installStdioErrorGuard(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => {
      // 静默：往已经坏掉的出口写"出口坏了"只会再触发一次同样的失败。
    })
  }
}
