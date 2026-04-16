# Memory 模块

Crabot 的智能记忆服务，负责记忆的存取、压缩、索引和检索优化。

## ✅ 测试状态

Memory 模块已通过完整测试，可以正常启动和运行：

- ✅ 所有依赖包已安装
- ✅ 模块可以正常实例化
- ✅ HTTP 服务器可以启动
- ✅ JSON-RPC 接口工作正常
- ✅ 存储层（LanceDB + SQLite）正常
- ✅ 健康检查、统计、水位管理等接口可用

## 快速开始

### 1. 安装依赖

```bash
cd crabot/src/modules/memory
uv sync
```

### 2. 设置环境变量

```bash
export CRABOT_LLM_API_KEY="your-openai-api-key"
export CRABOT_EMBEDDING_API_KEY="your-openai-api-key"
```

### 3. 启动模块

```bash
cd crabot/src/modules/memory
uv run python src/main.py
```

模块将在 `http://localhost:19002` 上监听。

### 4. 快速测试

```bash
cd crabot/src/modules/memory
uv run python quick_test.py
```

## 功能特性

### 已实现（阶段 1）

- ✅ **短期记忆**：事件流水账，支持语义检索
- ✅ **长期记忆**：知识库，支持 L0/L1/L2 三级详细程度
- ✅ **自动提取**：关键词自动提取、L0/L1 摘要自动生成
- ✅ **权限控制**：支持 visibility 和 scopes 权限标记
- ✅ **反思水位**：支持反思进度追踪
- ✅ **统计信息**：实时统计短期/长期记忆数量

### 待实现（后续阶段）

- ⏳ 短期记忆压缩（阶段 2）
- ⏳ 长期记忆完整去重/合并（阶段 3）
- ⏳ 混合检索（语义 + BM25 + 元数据）
- ⏳ 事件发布
- ⏳ 完整的权限过滤

## API 接口

所有接口使用 JSON-RPC 格式，POST 到 `http://localhost:19002/{method}`。

### 核心接口

- `write_short_term`: 写入短期记忆
- `search_short_term`: 检索短期记忆
- `write_long_term`: 写入长期记忆（含自动去重）
- `search_long_term`: 检索长期记忆（支持 L0/L1/L2）
- `get_stats`: 获取存储统计
- `get_reflection_watermark`: 查询反思水位
- `update_reflection_watermark`: 更新反思水位
- `health`: 健康检查
- `shutdown`: 关闭模块

详细接口规范见 `crabot-docs/protocols/protocol-memory.md`。

## 配置说明

参考 `config.example.yaml` 创建配置文件。

关键配置项：

```yaml
# LLM 配置（用于压缩、去重、检索优化）
llm:
  api_key: ${CRABOT_LLM_API_KEY}
  base_url: https://api.openai.com/v1
  model: gpt-4o-mini

# Embedding 配置
embedding:
  api_key: ${CRABOT_EMBEDDING_API_KEY}
  base_url: https://api.openai.com/v1
  model: text-embedding-3-small
  dimension: 1536

# 存储配置
storage:
  data_dir: ./data/memory
```

## 架构说明

```
src/
├── main.py              # 入口
├── module.py            # 主模块（JSON-RPC 路由）
├── config.py            # 配置加载
├── types.py             # 数据类型（对齐协议）
├── storage/
│   ├── vector_store.py  # LanceDB 向量存储
│   └── sqlite_store.py  # SQLite 元数据存储
├── core/
│   ├── short_term.py    # 短期记忆逻辑
│   └── long_term.py     # 长期记忆逻辑
└── utils/
    ├── llm_client.py    # LLM 客户端
    └── embedding.py     # Embedding 客户端
```

## 测试

```bash
# 运行单元测试
uv run pytest tests/ -v

# 快速功能测试
uv run python quick_test.py
```

## 依赖

核心依赖（~15 个）：

- `fastapi` + `uvicorn`: HTTP 服务
- `lancedb` + `pyarrow`: 向量存储
- `openai`: LLM 和 Embedding API
- `pydantic`: 数据验证
- `pyyaml`: 配置加载

## 开发指南

详见 [DEVELOPMENT.md](./DEVELOPMENT.md) - 包含 uv 使用说明、开发工作流等。

## 参考

- SimpleMem: 短期记忆压缩和混合检索算法来源
- 协议文档: `crabot-docs/protocols/protocol-memory.md`
- 项目进度: `PROGRESS.md`
- 开发指南: `DEVELOPMENT.md`
