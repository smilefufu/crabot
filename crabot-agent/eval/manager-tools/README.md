# Manager 工具加载评估

只读本地 JSONL，不连接 Provider、不执行工具、不修改线上开关。保留历史 full/shadow 标签用于旧记录分析；运行时已退役这两种模式，只采用渐进加载。外部 MCP 的独立开关与权限不变。

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

## 当前运行与历史记录

- Manager 首轮使用固定核心，其余能力按族加载或外部 MCP 搜索；不再读取旧模式和 ManagerKey cohort 环境变量。
- full/shadow 旧记录仍可由本报表读取，不新增该模式运行，也不把旧模式成绩称为当前配置基线。
- 新评测应先核对实际首请求核心及下一轮追加行为，不能仅凭启动环境或接口存在判断已启用渐进加载。
- Manager 外部 MCP 仍受独立发布开关和既有授权约束；本次不改变此边界。
