# Crabot Admin Web UI

Admin 模块的 Web 管理界面。

## 功能

- **模型供应商管理**：创建、编辑、删除 Model Provider，支持从预置厂商导入
- **Agent 实例管理**：查看和配置 Agent 实例
- **全局设置**：配置全局默认的 LLM 和 Embedding 模型

## 开发

```bash
# 安装依赖
cd web
npm install

# 开发模式（需要先启动 Admin 后端）
npm run dev

# 访问 http://localhost:5173
```

## 构建

```bash
# 在 crabot-admin 根目录
npm run build:web

# 或者构建后端和前端
npm run build:all
```

构建产物会输出到 `../dist/web/`，Admin 模块会自动提供静态文件服务。

## 技术栈

- React 19
- TypeScript
- React Router v6
- Vite
- 原生 CSS（无 UI 库依赖）

## 目录结构

```
web/
├── src/
│   ├── components/      # UI 组件
│   │   ├── Common/      # 通用组件（Button, Input, Card 等）
│   │   └── Layout/      # 布局组件（Header, Sidebar, MainLayout）
│   ├── pages/           # 页面组件
│   │   ├── Login/       # 登录页
│   │   ├── Providers/   # Provider 管理页面
│   │   ├── Agents/      # Agent 管理页面
│   │   └── Settings/    # 设置页面
│   ├── services/        # API 服务
│   ├── contexts/        # React Context
│   ├── types/           # TypeScript 类型
│   ├── utils/           # 工具函数
│   ├── App.tsx          # 主应用
│   ├── App.css          # 全局样式
│   └── main.tsx         # 入口文件
├── index.html
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 使用

1. 启动 Crabot 系统：
   ```bash
   ./launcher.sh start
   ```

2. 访问 Admin Web UI：
   ```
   http://localhost:3000
   ```

3. 使用管理员密码登录（环境变量 `CRABOT_ADMIN_PASSWORD`）

## API 代理

开发模式下，Vite 会将 `/api/*` 请求代理到 `http://localhost:3000`（Admin 后端）。

生产模式下，Admin 模块直接提供静态文件服务和 API。
