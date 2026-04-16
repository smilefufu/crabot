# Agent 实例启动链路实现

## 实现概述

已完成 Agent 实例从创建到启动的完整链路打通，实现了以下功能：

1. **扩展 RpcClient** - 添加 Module Manager 通信方法
2. **AgentManager 增强** - 创建实例时自动注册并启动模块
3. **Admin 模块集成** - 传递必要的依赖（RpcClient 和 RuntimeManager）
4. **类型扩展** - AgentInstance 新增 `module_registered` 和 `module_port` 字段
5. **清理机制** - 删除实例时自动停止并注销模块

## 核心改动

### 1. RpcClient 新增方法 (`src/core/module-base.ts`)

```typescript
// 注册模块定义
async registerModuleDefinition(moduleDefinition, source): Promise<{...}>

// 启动模块
async startModule(moduleId, source, entryOverride?, env?): Promise<{...}>

// 停止模块
async stopModule(moduleId, source): Promise<{...}>

// 注销模块定义
async unregisterModuleDefinition(moduleId, source): Promise<{...}>
```

### 2. AgentInstance 类型扩展 (`src/types.ts`)

```typescript
export interface AgentInstance {
  // ... 原有字段
  module_registered: boolean  // 是否已注册到 Module Manager
  module_port?: number         // 分配的端口
}
```

### 3. AgentManager.createInstance 增强 (`src/agent-manager.ts`)

**新增参数**：
- `rpcClient?: RpcClient` - 用于与 Module Manager 通信
- `runtimeManager?: RuntimeManager` - 用于生成启动命令

**新增逻辑**：
```typescript
// 如果是已安装的实现
if (impl.type === 'installed' && impl.installed_path && rpcClient && runtimeManager) {
  // 1. 构造启动命令
  const startCmd = runtimeManager.createStartCommand(...)

  // 2. 创建 ModuleDefinition
  const moduleDefinition = {
    module_id: instance.id,
    module_type: 'agent',
    entry: `${startCmd.command} ${startCmd.args.join(' ')}`,
    cwd: startCmd.cwd,
    env: {
      ...startCmd.env,
      CRABOT_MM_ENDPOINT: 'http://localhost:19000',
      CRABOT_AGENT_CONFIG_PATH: path.join(...)
    },
    auto_start: instance.auto_start,
    start_priority: instance.start_priority,
  }

  // 3. 向 Module Manager 注册
  await rpcClient.registerModuleDefinition(moduleDefinition, 'admin')

  // 4. 更新实例状态
  instance.module_registered = true

  // 5. 如果 auto_start，立即启动
  if (instance.auto_start) {
    await rpcClient.startModule(instance.id, 'admin')
  }
}
```

**错误回滚**：
- 如果注册/启动失败，自动删除实例记录和配置文件

### 4. AgentManager.deleteInstance 增强 (`src/agent-manager.ts`)

**新增参数**：
- `rpcClient?: RpcClient` - 用于清理模块

**新增逻辑**：
```typescript
// 如果是已安装的实现且已注册，先停止并注销模块
if (impl?.type === 'installed' && instance.module_registered && rpcClient) {
  await rpcClient.stopModule(id, 'admin')
  await rpcClient.unregisterModuleDefinition(id, 'admin')
}
```

### 5. ModuleInstaller 暴露 RuntimeManager (`src/module-installer.ts`)

```typescript
getRuntimeManager(): RuntimeManager {
  return this.runtimeManager
}
```

### 6. Admin 模块集成 (`src/index.ts`)

**handleCreateAgentInstance**：
```typescript
const instance = await this.agentManager.createInstance(
  params,
  this.rpcClient,
  this.moduleInstaller.getRuntimeManager()
)
```

**handleDeleteAgentInstance**：
```typescript
await this.agentManager.deleteInstance(params.instance_id, this.rpcClient)
```

**REST API 同步更新**：
- `handleCreateInstanceApi`
- `handleDeleteInstanceApi`

## 环境变量注入

创建实例时自动注入以下环境变量：

- `CRABOT_MODULE_ID` - 实例 ID（由 Module Manager 注入）
- `CRABOT_PORT` - 分配的端口（由 Module Manager 注入）
- `CRABOT_MM_ENDPOINT` - Module Manager 地址（`http://localhost:19000`）
- `CRABOT_AGENT_CONFIG_PATH` - Agent 配置文件路径

## 验证方案

### 1. 创建 Agent 实例

```bash
POST /api/agent-instances
{
  "implementation_id": "agent-default",
  "name": "Test Worker",
  "role": "worker",
  "specialization": "Test agent",
  "auto_start": true
}
```

**预期结果**：
- 返回 AgentInstance，包含 `module_registered: true`
- Module Manager 日志显示模块注册成功
- 模块进程启动

### 2. 检查模块状态

```bash
# 通过 Module Manager 查询
curl http://localhost:19000/rpc -d '{
  "method": "get_module",
  "params": {"module_id": "test-worker"}
}'
```

**预期结果**：
- 返回模块信息，`status: "running"`
- 包含分配的端口

### 3. 健康检查

```bash
curl http://localhost:{分配的端口}/health
```

**预期结果**：
```json
{
  "status": "healthy",
  "details": {
    "role": "worker",
    "idle": true,
    "current_task_count": 0,
    "available_capacity": 3
  }
}
```

### 4. 删除实例

```bash
DELETE /api/agent-instances/test-worker
```

**预期结果**：
- 模块进程被停止
- Module Manager 中模块定义被注销
- 端口被释放

## 注意事项

1. **端口分配**：Module Manager 会自动分配端口，Admin 需要查询并保存
2. **启动顺序**：先注册 ModuleDefinition，再启动模块
3. **错误处理**：如果启动失败，需要回滚（删除实例记录、注销模块定义）
4. **配置文件路径**：确保 `CRABOT_AGENT_CONFIG_PATH` 指向正确的配置文件
5. **工作目录**：`cwd` 必须设置为 `installed_path`，否则模块找不到依赖

## 后续工作

1. **端口查询**：实现从 Module Manager 查询分配的端口并保存到 `module_port` 字段
2. **健康检查**：定期检查模块健康状态
3. **自动重启**：模块崩溃时自动重启
4. **日志收集**：收集模块的标准输出和错误输出
