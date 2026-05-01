import path from 'node:path'

export function getAgentDataDir(): string {
  return path.resolve(process.env.DATA_DIR ?? './data')
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

export function getInstanceSkillsDir(): string {
  return path.join(getAgentDataDir(), 'instance', 'skills')
}
