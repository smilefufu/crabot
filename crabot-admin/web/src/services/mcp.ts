import { api } from './api'
import type { MCPServerRegistryEntry, EssentialToolsConfig } from '../types'

export const mcpService = {
  async list(): Promise<MCPServerRegistryEntry[]> {
    return api.get<MCPServerRegistryEntry[]>('/mcp-servers')
  },

  async get(id: string): Promise<MCPServerRegistryEntry> {
    return api.get<MCPServerRegistryEntry>(`/mcp-servers/${id}`)
  },

  async create(data: {
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
    description?: string
    install_method?: MCPServerRegistryEntry['install_method']
  }): Promise<MCPServerRegistryEntry> {
    return api.post<MCPServerRegistryEntry>('/mcp-servers', data)
  },

  async update(id: string, data: Partial<MCPServerRegistryEntry>): Promise<MCPServerRegistryEntry> {
    return api.patch<MCPServerRegistryEntry>(`/mcp-servers/${id}`, data)
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/mcp-servers/${id}`)
  },

  async importFromJson(json: string): Promise<{ entries: MCPServerRegistryEntry[]; count: number }> {
    return api.post('/mcp-servers/import-json', { json })
  },

  async getEssentialTools(): Promise<EssentialToolsConfig> {
    return api.get<EssentialToolsConfig>('/essential-tools')
  },

  async updateEssentialTools(data: Partial<EssentialToolsConfig>): Promise<EssentialToolsConfig> {
    return api.patch<EssentialToolsConfig>('/essential-tools', data)
  },
}
