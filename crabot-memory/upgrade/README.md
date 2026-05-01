# crabot-memory 升级说明

## v2 → v3（2026-04-30）

**主题**：移除 embedding 子系统。

**做了什么**：

- 短期记忆从 LanceDB 迁到 SQLite（不再需要 vector 列）
- 长期记忆删除 dense recall path（5 路 → 4 路 RRF：sparse / entity / tag / bi_temporal）
- 删除 EmbeddingClient + 所有 `CRABOT_EMBEDDING_*` 配置
- Admin 删除 embedding provider 配置和 UI

**升级脚本 `from_v2_to_v3.py` 行为**：

1. `data/memory/lancedb/` 目录改名为 `lancedb.deprecated.{ts}/`（保留备份）
2. `data/memory/long_term_v2.db` 中 drop `embeddings` 表 + VACUUM
3. 清洗 `data/admin/module-configs/memory-*.json` 里的 `CRABOT_EMBEDDING_*` env vars
4. 清洗 `data/admin/global-config.json` 里的 `default_embedding_*` 字段
5. 写日志到 `data/memory/upgrade-v2-to-v3.log`

**数据丢失说明**：

- 老的 short_term LanceDB 数据**不再读取**（项目初期阶段，可接受丢失）
- `lancedb.deprecated.{ts}/` 保留是为人工恢复路径（默认 7 天后由用户自行清理）
- 长期记忆条目本身（`data/memory/long_term/{status}/{type}/*.md`）完整保留，只丢失向量索引

**回滚**：

```bash
# 1. 切回旧代码
git checkout v2.x
# 2. 恢复数据（crabot upgrade 已自动备份整个 data/memory/ 目录）
rm -rf data/memory
mv data/memory.backup-{ts} data/memory
# 3. 启动
crabot start
```

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

升级框架会自动备份 `<DATA_DIR>/memory/` 到 `<DATA_DIR>/memory.backup-<ts>/`。失败时 `SCHEMA_VERSION` 不会被写入；`crabot stop` 后手工 `rm -rf <DATA_DIR>/memory && mv <DATA_DIR>/memory.backup-<ts> <DATA_DIR>/memory` 即可恢复，再次执行 `crabot upgrade` 重试。
