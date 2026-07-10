/**
 * OpenClaw 迁移导入 API 客户端。
 *
 * parse：上传备份 .tar.gz（可能 GB 级，发原始二进制流，不走 JSON/multipart）。
 * execute：按用户勾选执行导入。
 */
import { api } from './api'
import { storage } from '../utils/storage'

export interface ProviderOverviewItem {
  source_name: string
  endpoint: string
  format: 'openai' | 'anthropic' | 'gemini' | 'openai-responses' | null
  migratable: boolean
  skip_reason?: 'oauth' | 'secret-ref' | 'unsupported-format'
  has_api_key: boolean
}

export interface ChannelOverviewItem {
  source_channel: string
  account_id?: string
  channel: string
  migratable: boolean
  crabot_type?: 'telegram' | 'feishu'
  feishu_domain?: 'feishu' | 'lark'
  credentials?: 'available' | 'unavailable'
  skip_reason?: 'unsupported-channel' | 'invalid-name'
}

export interface McpOverviewItem {
  source_name: string
  name: string
  transport: 'stdio' | 'streamable-http' | 'sse'
  migratable: boolean
  requires_local_env?: boolean
}

export interface BackupOverview {
  manifest: { schemaVersion: number; includeWorkspace: boolean; createdAt: string; runtimeVersion: string }
  providers: ProviderOverviewItem[]
  channels: ChannelOverviewItem[]
  mcpServers: McpOverviewItem[]
  skills: string[]
  memory: { present: boolean; fileCount: number }
  workspace: { present: boolean; fileCount: number }
}

export interface ImportSelections {
  providers: string[]
  channels: Array<{ source_channel: string; account_id: string }>
  mcp: string[]
  skills: string[]
  memory: boolean
  workspace: boolean
}

export interface ImportSummary {
  results: Array<{
    kind: 'provider' | 'channel' | 'mcp' | 'skill' | 'memory' | 'workspace'
    name: string
    status: 'imported' | 'skipped'
    reason?: 'conflict' | 'not-migratable' | 'missing-secret' | 'invalid-name'
  }>
  errors: string[]
}

export const openclawImportService = {
  /** 上传备份并解析出概览（原始二进制流上传）。 */
  async parseBackup(file: File): Promise<{ token: string; overview: BackupOverview }> {
    const token = storage.getToken()
    const res = await fetch('/api/openclaw-import/parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error || '解析备份失败')
    }
    return res.json()
  },

  /** 按勾选执行导入。 */
  async executeImport(token: string, selections: ImportSelections): Promise<ImportSummary> {
    return api.post<ImportSummary>('/openclaw-import/execute', { token, selections })
  },
}
