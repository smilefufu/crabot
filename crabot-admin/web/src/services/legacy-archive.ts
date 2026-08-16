/**
 * P6-D：Legacy Agent archive 服务（protocol-admin §3.18）。
 * 普通列表只含 sanitized summary；raw 只在显式 export 时出现。
 */

import { api } from './api'

export interface LegacyAgentArchiveSummary {
  archive_id: string
  source_kind: 'agent_implementation' | 'agent_instance' | 'agent_config' | 'installed_package'
  module_id?: string
  archived_at: string
  support_status: 'unsupported_legacy'
  uninstallable: boolean
  display_name?: string
  version?: string
}

export interface DeleteLegacyAgentArchiveResult {
  archive_id: string
  completed: true
  archive_removed: boolean
  deleted_resources: string[]
  retained_resources: string[]
}

export const legacyArchiveService = {
  async list(): Promise<LegacyAgentArchiveSummary[]> {
    const response = await api.get<{ items: LegacyAgentArchiveSummary[] }>('/legacy-agent-archive')
    return response.items
  },

  async export(archiveId: string): Promise<unknown> {
    const response = await api.get<{ record: unknown }>(`/legacy-agent-archive/${encodeURIComponent(archiveId)}/export`)
    return response.record
  },

  async remove(
    archiveId: string,
    selection: { delete_package: boolean; delete_config: boolean },
  ): Promise<DeleteLegacyAgentArchiveResult> {
    return api.delete<DeleteLegacyAgentArchiveResult>(
      `/legacy-agent-archive/${encodeURIComponent(archiveId)}`,
      { confirmation: archiveId, ...selection },
    )
  },
}
