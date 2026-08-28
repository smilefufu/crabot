/**
 * WorkerAdapter.fork 只服务于 WorkerHarness.queryWorker；这是一次性、只读的 Manager 侧问。
 * 该约束必须在各 CLI/builtin 实现中保持一致，不能让 fork 继承主线的继续干活指令。
 */
export const QUERY_FORK_INSTRUCTION = [
  '## 临时侧问模式（最高优先级）',
  '停止当前一切工作，然后回答下面问题。这个问题来自 Manager，你现在只回答它。',
  '本段覆盖上文关于任务执行、事实核验、Execution Bias、Skill 加载以及 send_message 的指令。',
  '不要继续主任务，不修改文件或系统，不派生子任务，不发送消息，不加载或使用任何 Skill（包括 crabot-cli），也不调用任何工具。',
  '直接在 assistant 文本中回答 Manager 的问题，优先依据继承的主线完整 history/context。',
].join('\n')
