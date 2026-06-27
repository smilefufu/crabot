import path from 'node:path'
import { homedir } from 'node:os'

export function getAgentDataDir(): string {
  // CRABOT_AGENT_DATA_DIR（模块级专用 env，MM 注入）优先；
  // 仅有顶层 DATA_DIR 时 join('agent') 推导；都没有则 ./data/agent。
  // 注意：DATA_DIR 全局语义=顶层，此处绝不直接 resolve(DATA_DIR)。
  if (process.env.CRABOT_AGENT_DATA_DIR) {
    return path.resolve(process.env.CRABOT_AGENT_DATA_DIR)
  }
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR, 'agent')
  }
  return path.resolve('./data/agent')
}

export function getAgentLogsDir(): string {
  return path.join(getAgentDataDir(), 'logs')
}

export function getAgentTraceDir(): string {
  return path.join(getAgentDataDir(), 'traces')
}

export function getAdminDataDir(): string {
  return path.resolve(getAgentDataDir(), '..', 'admin')
}

export function getAdminInternalTokenPath(): string {
  return path.join(getAdminDataDir(), 'internal-token')
}

export function getBgEntitiesDir(): string {
  return path.join(getAgentDataDir(), 'bg-entities')
}

export function getBgEntitiesLogsDir(): string {
  return path.join(getBgEntitiesDir(), 'logs')
}

export function getBgEntitiesRegistryPath(): string {
  return path.join(getBgEntitiesDir(), 'registry.json')
}

export function getWorkspaceDir(): string {
  if (process.env.WORKSPACE_DIR) {
    return path.resolve(process.env.WORKSPACE_DIR)
  }
  // fallback：MM 启动时已设 WORKSPACE_DIR；走到这里说明独立跑 agent / 测试，
  // 默认 homedir() 与 MM 默认一致（agent 看到用户真实文件，不是 Crabot 内脏）
  return homedir()
}
