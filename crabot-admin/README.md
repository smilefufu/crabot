# Crabot Admin

Crabot 管理模块 - 管理界面和数据层

## 功能

- Friend（熟人）管理
- Permission（权限）管理
- Task（任务）管理
- Schedule（调度）管理
- 认证与授权
- Web 管理界面
- REST API

## 安装

```bash
npm install
```

## 开发

```bash
# 开发模式
npm run dev

# 编译
npm run build

# 运行测试
npm test
```

## 使用

```bash
# 启动 Admin 模块（需要先启动 Module Manager）
npm start
```

## 配置

环境变量：
- `MODULE_MANAGER_URL` - Module Manager 地址（默认 http://localhost:19000）
- `WEB_PORT` - Web 界面端口（默认 3000）
- `JWT_SECRET` - JWT 密钥
- `JWT_EXPIRES_IN` - Token 有效期（默认 24h）
- `ADMIN_PASSWORD` - 管理员密码

## 文档

- [架构概览](../crabot-docs/architecture/overview.md)
- [协议规范](../crabot-docs/protocols/protocol-admin.md)

## 许可证

Apache-2.0
