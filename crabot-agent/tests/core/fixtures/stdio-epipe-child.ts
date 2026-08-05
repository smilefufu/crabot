/**
 * `stdio-guard.test.ts` 的被测子进程 —— 真复现：父进程关掉管道读端后继续 `console.error`。
 *
 * 跑法是 `node --experimental-strip-types`（Node 22.6+），因此这里**直接 import 生产代码**
 * （带 `.ts` 后缀，type stripping 的解析规则）。用 inline 一份等价实现就测不到生产代码，
 * 变异（删掉 `installStdioErrorGuard` 的监听器）也不会挂。
 *
 * 约定：
 * - `GUARD=1` 装生产守卫，`GUARD=0` 不装（不装 = 事故当天的现场）；
 * - 崩溃时以 42 退出（`uncaughtException` 处理器，复刻 `main.ts` 的 `exit(1)` 语义，
 *   换个码是为了与"写到一半被信号打死"区分开）；活到最后正常 0 退出。
 */
import { installStdioErrorGuard } from '../../../src/core/stdio-guard.ts'

if (process.env.GUARD === '1') installStdioErrorGuard()

process.on('uncaughtException', () => {
  process.exit(42)
})

let n = 0
const timer = setInterval(() => {
  n++
  // 一条日志不够：Node 的 Console 自带的防护只挡得住第一条（`errorEmitted` 黏性），
  // 事故里也是重试风暴刷屏才炸的。
  console.error(`noisy retry log line ${'x'.repeat(2000)} ${n}`)
  console.log(`noisy stdout line ${'x'.repeat(2000)} ${n}`)
  if (n > 40) {
    clearInterval(timer)
    process.exit(0)
  }
}, 5)
