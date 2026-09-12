# Manager 工具加载评估

只读本地 JSONL，不连接 Provider、不执行工具、不修改线上开关。运行时保持默认 `full`，外部 MCP 默认关闭。

```sh
node eval/manager-tools/report.mjs --start 2026-09-12T00:00:00Z --end 2026-09-19T00:00:00Z --rates rates.json traces-oldest.jsonl traces-latest.jsonl
```

- 文件按旧到新传入，同一 `trace_id` 取最后一条；先读取日期归档，再读取对应的 running 快照。使用静态副本，避免边写边读。无 `kind=manager_episode` 的旧记录不纳入。
- 时间窗口按 episode 开始时间选取，含 start、不含 end；这是 episode 对照，不是账单期间核算。未结束或跨 end 的 episode 不进入完整成本均值。
- `groups` 按 provider/model/format/profile/wake type/mode 分层。技术完成率不等于业务成功率。混合模型或模式的 episode 不进入同质对照，但其全部请求保留在 `request_groups`。
- 唯一计费来源是请求事实，包括重试与压缩；不再累加 `llm_call` 或 `total_usage`。`observed_cost` 和 `reported_usage` 只汇总已知部分，不是完整成本；失败、缺失用量或缺失请求记录会使完整均值为 null。
- cache 缺失保持 null，明确上报的 0 才是零命中。OpenAI 兼容格式仍可从统一 adapter 用量重建总 token workload，但缺缓存拆分时不推算货币成本；Anthropic 缺缓存创建/读取时 workload 同样不完整。
- 缺乏覆盖记录、重启续跑、记录损坏、同一 ManagerKey 在窗口内切模式均阻止自动给出通过的比较结果。重启请求仍纳入已知用量，不伪造丢失的失败请求。
- `comparisons.gates` 只是 spec 阈值的点估计。72 小时/7 日、500/1,000 episode、指定会话选择、Worker 必处置 turn 闭环、无命中是否已解决、人工检索集和 MCP 权限门禁仍须单独验收，脚本永远返回 `manual_review_required`。
- `send_private_message` 只从历史工具频率比较排除，不扣减它产生的真实请求成本。

## 离线费率表

不抓实时价格或按模型名猜价格。实验开始时固定 `version`，精确匹配三个身份字段；币种不跨组汇总。以下数值仅演示格式，不能用于实际决策：

```json
{
  "version": "example-only-not-production-prices",
  "entries": [
    {
      "provider_id": "example-cloud",
      "model_id": "example-model",
      "format": "openai",
      "kind": "cloud",
      "currency": "USD",
      "per_million": { "input": 1, "cache_read": 0.1, "cache_creation": 1, "output": 2 }
    },
    {
      "provider_id": "example-local",
      "model_id": "example-model",
      "format": "openai",
      "kind": "self_hosted"
    }
  ]
}
```

## 发布顺序

1. 独立发布只包含自省退役/合并的 55 工具语义基线，至少观察 72 小时。它是独立代码版本，不是第四个加载模式。
2. 加载器版本默认 `full`：普通 56 项。`shadow` 保持相同 prompt/工具面、仅观测，至少 7 日。
3. 使用 `CRABOT_MANAGER_TOOL_LOADING_MODE=progressive` 和显式的 `CRABOT_MANAGER_TOOL_LOADING_KEYS` 逗号分隔完整键启用指定会话。未列出的键保持 full；同一评估窗口不切组。只有刻意全量运行时才省略 keys。
4. 内置工具验收后，按 spec 权限范围单独设置 `CRABOT_MANAGER_MCP_ENABLED=1`。这不是 MCP 权限授予入口，full/shadow 不开放外部 MCP。
5. 回退：下一 episode 设置 full 并关闭 MCP；保持同一 prompt/cache key 和核心顺序。在途 MCP 按原 timeout 收口，不重发。加载器自身故障回滚代码到 55 工具版本。

这些环境变量是内部临时发布控制，不是 Admin 配置。单进程中修改环境只用于测试；线上须通过既有部署入口发布环境，不能靠编辑外部 shell 环境热改运行中进程。
