# Memory 模块开发指南

## 使用 uv 进行开发

本项目使用 [uv](https://github.com/astral-sh/uv) 作为 Python 包管理工具。

### 为什么使用 uv？

- ⚡ **快速**：比 pip 快 10-100 倍
- 🔒 **可靠**：自动锁定依赖版本
- 🎯 **简单**：统一的工具链
- 🔄 **兼容**：完全兼容 pip/pyproject.toml

### 安装 uv

```bash
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# 或使用 pip
pip install uv
```

### 开发工作流

```bash
# 1. 克隆项目
cd crabot/src/modules/memory

# 2. 安装依赖（自动创建虚拟环境）
uv sync

# 3. 运行模块
uv run python src/main.py

# 4. 运行测试
uv run pytest tests/ -v

# 5. 添加新依赖
uv add package-name

# 6. 添加开发依赖
uv add --dev package-name

# 7. 更新依赖
uv sync --upgrade
```

### 常用命令

```bash
# 运行 Python 脚本
uv run python script.py

# 运行模块
uv run python -m module_name

# 进入虚拟环境
source .venv/bin/activate  # macOS/Linux
.venv\Scripts\activate     # Windows

# 查看依赖树
uv tree

# 锁定依赖
uv lock

# 清理缓存
uv cache clean
```

### 项目结构

```
memory/
├── pyproject.toml      # 项目配置和依赖
├── uv.lock            # 依赖锁定文件（自动生成）
├── .venv/             # 虚拟环境（自动创建）
└── src/               # 源代码
```

### CI/CD 集成

```yaml
# GitHub Actions 示例
- name: Install uv
  run: curl -LsSf https://astral.sh/uv/install.sh | sh

- name: Install dependencies
  run: uv sync

- name: Run tests
  run: uv run pytest
```

### 迁移说明

如果你之前使用 pip/poetry/pipenv：

```bash
# 从 requirements.txt 迁移
uv pip compile requirements.txt -o pyproject.toml

# 从 poetry 迁移
# pyproject.toml 已经兼容，直接运行
uv sync

# 从 pipenv 迁移
# 将 Pipfile 依赖复制到 pyproject.toml
uv sync
```

### 故障排除

**问题：uv 命令找不到**
```bash
# 确保 uv 在 PATH 中
export PATH="$HOME/.cargo/bin:$PATH"
```

**问题：依赖冲突**
```bash
# 清理并重新安装
rm -rf .venv uv.lock
uv sync
```

**问题：需要特定 Python 版本**
```bash
# uv 会自动下载和管理 Python 版本
uv python install 3.10
uv sync
```

### 参考资料

- [uv 官方文档](https://docs.astral.sh/uv/)
- [uv GitHub](https://github.com/astral-sh/uv)
- [pyproject.toml 规范](https://packaging.python.org/en/latest/specifications/pyproject-toml/)
