import fs from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { Workspace } from '../types.js'

const capabilityKeys = ['mcp_servers', 'notify', 'hooks', 'plugins', 'marketplaces', 'allow_managed_hooks_only']
const connectionKeys = ['model', 'model_provider', 'model_providers', 'openai_base_url']

/** Native project layers outrank CODEX_HOME. Refuse conflicting layers without overwriting user files or exposing credentials in argv. */
export async function assertCodexProjectConfiguration(workspace: Workspace, codexHome: string, connectionEnv?: Record<string, string>): Promise<void> {
  if (!workspace.runtime_root) return
  let controlled: Record<string, unknown> = {}
  try { controlled = parse(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Codex运行配置无法核验，未启动执行器。')
  }
  const markers = controlled.project_root_markers ?? ['.git']
  if (!Array.isArray(markers) || markers.some(marker => typeof marker !== 'string' || !marker || path.basename(marker) !== marker)) {
    throw new Error('Codex项目配置搜索边界无法核验；原文件已保留，请选择内置执行器。')
  }
  const cwd = await fs.realpath(workspace.root), ancestors = [cwd]
  let directory = cwd, found = false
  for (;;) {
    for (const marker of markers as string[]) {
      try { await fs.lstat(path.join(directory, marker)); found = true; break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (found || path.dirname(directory) === directory) break
    directory = path.dirname(directory); ancestors.push(directory)
  }
  const layers = found ? ancestors : [cwd]
  for (const layer of layers) {
    const file = path.join(layer, '.codex', 'config.toml')
    let raw: string
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('unverifiable project configuration')
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error('Codex项目配置无法安全核验；原文件已保留，请选择内置执行器。')
    }
    let config: Record<string, unknown>
    try { config = parse(raw) } catch { throw new Error('Codex项目配置无法解析；原文件已保留，请检查该项目的原生配置。') }
    const protectedKeys = connectionEnv?.CODEX_HOME ? [...capabilityKeys, ...connectionKeys] : capabilityKeys
    const conflicts = protectedKeys.filter(key => Object.prototype.hasOwnProperty.call(config, key))
    if (conflicts.length) throw new Error('Codex项目配置会覆盖Crabot管理的执行环境（' + conflicts.join(', ') + '）；原文件已保留。请在Crabot配置对应能力，或选择内置执行器。')
  }
}
