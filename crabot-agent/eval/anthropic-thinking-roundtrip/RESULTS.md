# Anthropic 推理历史往返验证

日期：2026-09-20。结论：确定性往返缺陷已修复，Kimi 重复发送的模型行为验收未通过，不宣称事故已根治。未部署。

## 确定性验证

新回归先复现四项失败：推理/签名丢失及文本顺序合并、原生推理缺失、容量估算漏算、纯推理历史被删。修复后新增8项回归全部通过。

覆盖：原始 SSE（包括已安装 SDK 的真实解析器）→ adapter → Engine → 下一请求；Manager session/checkpoint 保存恢复；builtin SessionTree 保存恢复；压缩尾部保持完整；空 thinking、分片签名和 redacted_thinking；跨格式过滤；无工具 fork 的推理及缓存标记；流失败不产生成功内容。

Agent 构建通过；13个相关测试文件352项通过。命令使用 `vitest run ... --testTimeout=15000`，覆盖 anthropic-thinking-roundtrip、anthropic-adapter、llm-adapter、thinking-mapping、stream-processor、query-loop、context-manager、send-message-guard、stream-timeout、manager session-store/restart-resume、worker session-tree/builtin-adapter。

## 真实 K3 请求

同一批准轮次合计4次请求，原 Kimi Code 端点、model=k3；每次最多4096输出 token，无自动重试，不执行真实工具。前2次使用已授权事故历史重建，后2次为已确认 spec 中的新上下文人工算术任务。没有继续消耗请求做统计采样。

| 请求 | 输入 token（含缓存） | thinking token | 停止与动作 |
| --- | ---: | ---: | --- |
| 旧历史，原 effort=high 配置 | 707560 | 0 | tool_use，发送一次核实说明 |
| 同一旧历史，显式 enabled/budget=2048 | 707560 | 0 | tool_use，发送一次回答 |
| 新上下文，人工17×23任务 | 221 | 63 | tool_use，send_message 正确结果 |
| 原样回传上一响应推理及签名，附模拟发送成功回执 | 381 | 57 | tool_use，send_message 的 content 为空，未 end_turn |

首次新上下文响应含125字符 thinking 和4340字符签名。将真实原始事件交给修复后的 adapter，经 callNonStreaming、EngineAssistantMessage 和 JSON 序列化恢复，再由 normalizeMessagesForAnthropic 生成下一请求；与原生块逐项深度相等，包括工具参数。该完整回传结果用于最后一次真实请求。

两个旧历史响应均无推理块，无法构造原计划的保留/删除 thinking 配对。旧历史重建不包含已丢失的历史 thinking，也没有当时完整 dialog-profile 快照；不得称作精确原始 HTTP 请求复现。

最后一次响应的推理表明已识别发送成功及应结束的任务状态，但原始输出仍是空内容工具调用。它不是同文重复的统计证明，却足以否定“修复往返后此测试已正常结束”。不能据此断言是 K3 模型本体还是兼容服务的结束映射问题；需后续独立实验区分。

## 发布边界

本次修复保留原生推理和顺序，不改变思考启用参数、结束回合、send_message 保护或超时语义。保留反例，继续调查结束意图与原生工具输出之间的偏差；不根据 thinking 自行结束、不把空发送视为 end_turn、不自动改写旧历史。
