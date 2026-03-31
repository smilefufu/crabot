# Crabot Core

Crabot 核心模块 - Module Manager

## 功能

- 模块生命周期管理（注册、启动、停止、重启）
- 端口动态分配
- 服务发现（按 ID 和按类型）
- 事件系统（发布-订阅）
- 健康检查
- 进程管理

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
# 启动 Module Manager
npm start

# 或指定端口
PORT=19000 npm start
```

## 配置

环境变量：
- `PORT` - 监听端口（默认 19000）
- `PORT_RANGE_START` - 模块端口范围最小值（默认 19002）
- `PORT_RANGE_END` - 模块端口范围最大值（默认 19099）
- `HEALTH_CHECK_INTERVAL` - 健康检查间隔秒数（默认 30）
- `CRABOT_PORT_OFFSET` - 端口偏移量，用于多实例部署（默认 0）。设置后所有端口自动偏移，如 `CRABOT_PORT_OFFSET=100` 时 MM 监听 19100

## 文档

- [架构概览](../crabot-docs/architecture/overview.md)
- [模块系统](../crabot-docs/architecture/module-system.md)
- [协议规范](../crabot-docs/protocols/protocol-module-manager.md)

## 许可证

MIT
