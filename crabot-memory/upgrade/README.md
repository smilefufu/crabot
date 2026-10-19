# crabot-memory 升级说明

## v4 → v5（2026-10-10）

长期文件及历史版本缺少 `visibility`/`scopes` 时补为 `internal`/`[]`，已有标记保持原值。索引只增加标记列并更新对应值，保留使用统计、task usage、观察期状态、水位和画像；不调用 LLM。非法已有标记保持损坏状态，读取拒绝，不猜测归属或降级 private。

停止 MM 后，可先在 Memory 项目目录运行 `uv run python upgrade/from_v4_to_v5.py --data-dir=<DATA_DIR>/memory --dry-run`。dry-run 只读统计，不创建数据库或输出正文。正式升级、启动兜底与独立写入脚本共同使用范围事务：只备份本链实际转换的 Markdown、数据库及必要伴随文件，另记录新路径原先不存在的事实，不复制 metadata、观察日志或整个 Memory。备份与计划保存在 `<DATA_DIR>/.upgrade-migrations/<迁移标识>/`，脚本不再创建第二份备份；转换失败只恢复声明范围。独立脚本仍不推进 `SCHEMA_VERSION`，正式升级/启动在核验已转换结果后提交版本，不重做转换。未知中断状态拒绝启动，保留原计划供恢复核对，不能用整模块覆盖处理。

## v2 → v3（2026-04-30）

**主题**：移除 embedding 子系统。

**做了什么**：

- 短期记忆从 LanceDB 迁到 SQLite（不再需要 vector 列）
- 长期记忆删除 dense recall path（5 路 → 4 路 RRF：sparse / entity / tag / bi_temporal）
- 删除 EmbeddingClient + 所有 `CRABOT_EMBEDDING_*` 配置
- Admin 删除 embedding provider 配置和 UI

**升级脚本 `from_v2_to_v3.py` 行为**：

1. `data/memory/lancedb/` 目录改名为 `lancedb.deprecated.<迁移标识>/`（保留备份）
2. `data/memory/long_term_v2.db` 中 drop `embeddings` 表 + VACUUM
3. 清洗 `data/admin/module-configs/memory-*.json` 里的 `CRABOT_EMBEDDING_*` env vars
4. 清洗 `data/admin/global-config.json` 里的 `default_embedding_*` 字段
5. 写日志到 `data/memory/upgrade-v2-to-v3.log`

**数据丢失说明**：

- 老的 short_term LanceDB 数据**不再读取**（项目初期阶段，可接受丢失）
- `lancedb.deprecated.<迁移标识>/` 保留是为人工恢复路径（默认 7 天后由用户自行清理）
- 长期记忆条目本身（`data/memory/long_term/{status}/{type}/*.md`）完整保留，只丢失向量索引

**回滚**：

恢复材料同时包含实际改写的 Memory 文件与特定 Admin 配置路径。捕获到的转换失败由共同事务恢复；未知中断先核对事务计划和范围，不能删除整个 Memory 或 Admin 后覆盖。恢复旧代码前还需核对数据版本及是否已有升级后业务写入。

**完整设计**：见 `crabot-docs/superpowers/specs/2026-04-30-remove-embedding-design.md`。

---

## v1 → v2

旧 LanceDB `long_term_memory` 表 → 新文件结构 `<DATA_DIR>/long_term/<status>/<type>/<uuid>.md` + SQLite 索引。

### 字段映射

| 旧字段 | 新位置 | 说明 |
|---|---|---|
| `abstract` (L0) | frontmatter `brief` | ≤80 字，超出截断（warning） |
| `overview` (L1) | 弃用 | 长度若 > content/2 → warning |
| `content` (L2) | markdown body | 直接复制 |
| `importance: int` (0-10) | `importance_factors`（4 项 0-1） | proximity = importance/10，其他默认 0.5 |
| `entities` | frontmatter `entities` | 结构兼容 |
| `tags` | frontmatter `tags` | 直接复制 |
| `source` | frontmatter `source_ref` | 字段重命名 |
| `read_count` | `lesson_meta.use_count` | 仅 lesson 类型 |
| `version` | frontmatter `version` | 直接复制 |
| `created_at`/`updated_at` | `event_time`/`ingestion_time` | 旧记录两个时间合并 |

### 类型推断（旧记录无 type 字段）

- 旧 tags 含 `task_experience` 或 `lesson` → `lesson`
- 旧 `entities` 非空且与某 entity 强相关 → `fact`
- 其他 → `concept`

### maturity 默认

- `fact` → `confirmed`
- `lesson` → `case`
- `concept` → `established`

### 已知警告范例

```
WARN entry-0042: overview length > content/2, overview discarded
WARN entry-0107: abstract truncated (>80 chars)
WARN entry-0233: type ambiguous, defaulted to 'concept'
```

### 失败恢复

升级框架按整条实际执行链声明恢复范围，只保存相应旧文件与原缺失路径。写入前验证失败不运行转换；捕获到的转换失败恢复该范围，版本保持原值。无法证明状态的中断保留事务并阻止启动，按计划核对恢复，不重跑未知转换或覆盖整个数据目录。
