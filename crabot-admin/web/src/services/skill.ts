import { api } from './api'
import type { SkillRegistryEntry } from '../types'

export interface GitSkillItem {
  path: string
  name: string
  description: string
  skill_md_url: string
}

export const skillService = {
  async list(): Promise<SkillRegistryEntry[]> {
    return api.get<SkillRegistryEntry[]>('/skills')
  },

  async get(id: string): Promise<SkillRegistryEntry> {
    return api.get<SkillRegistryEntry>(`/skills/${id}`)
  },

  async create(data: {
    name: string
    description: string
    content: string
    version?: string
    trigger_phrases?: string[]
  }): Promise<SkillRegistryEntry> {
    return api.post<SkillRegistryEntry>('/skills', data)
  },

  async update(id: string, data: Partial<SkillRegistryEntry>): Promise<SkillRegistryEntry> {
    return api.patch<SkillRegistryEntry>(`/skills/${id}`, data)
  },

  async delete(id: string): Promise<void> {
    await api.delete(`/skills/${id}`)
  },

  async scanGitRepo(git_url: string): Promise<{ skills: GitSkillItem[] }> {
    return api.post('/skills/import-git/scan', { git_url })
  },

  async installFromGit(skill_md_url: string, source_git_url?: string): Promise<SkillRegistryEntry> {
    return api.post<SkillRegistryEntry>('/skills/import-git/install', { skill_md_url, source_git_url })
  },

  async importFromLocal(dir_path: string): Promise<SkillRegistryEntry> {
    return api.post<SkillRegistryEntry>('/skills/import-local', { dir_path })
  },

  async importFromUpload(base64_content: string, filename: string): Promise<SkillRegistryEntry> {
    return api.post<SkillRegistryEntry>('/skills/import-upload', { base64_content, filename })
  },
}
