# crabot-memory 升级说明

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
