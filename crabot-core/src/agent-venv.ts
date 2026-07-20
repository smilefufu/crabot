/**
 * Agent 专用 Python 环境（$DATA_DIR/agent-venv）
 *
 * install.sh 装的 uv 原本只服务 memory 模块（uv sync），agent 的 bash 工具继承
 * MM 进程 PATH，python3/pip3 会落到系统 python 并污染其 site-packages。
 * 这里在 MM 启动时懒创建一个 uv 管理的实例级 venv，并把其 bin 前置到 PATH，
 * 经 spawn 的 process.env 透传给所有子模块，agent shell 里的 python3/pip3
 * 随之解析到该 venv。uv 不可用或创建失败时返回 null（降级为原 PATH，等价历史行为）。
 *
 * 详见 crabot-docs/superpowers/specs/2026-07-19-agent-python-venv-design.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveExecutable } from './executable-resolver.js'

const IS_WIN = process.platform === 'win32'

type SpawnFn = typeof spawnSync

/**
 * 确保 $DATA_DIR/agent-venv 存在（缺失/损坏时用 uv 重建），返回前置了 venv bin
 * 的新 PATH；失败返回 null（调用方保持原 PATH）。
 *
 * spawn 参数仅用于测试注入，生产走默认 spawnSync。
 */
export function ensureAgentVenv(dataDir: string, spawn: SpawnFn = spawnSync): string | null {
  const venvDir = path.join(dataDir, 'agent-venv')
  const venvBin = path.join(venvDir, IS_WIN ? 'Scripts' : 'bin')
  const venvPython = path.join(venvBin, IS_WIN ? 'python.exe' : 'python')

  if (!fs.existsSync(venvPython)) {
    const uv = resolveExecutable('uv')
    // --seed 必须带：uv venv 默认不装 pip，无 seed 时 venv 内没有 pip3。
    const r = spawn(uv, ['venv', '--seed', venvDir], { encoding: 'utf-8' })
    if (r.error || r.status !== 0) {
      console.warn(
        `[ModuleManager] agent venv 创建失败，跳过 PATH 注入（agent 将使用系统 python）: ${
          r.error ? r.error.message : (r.stderr || `exit ${r.status}`).toString().trim()
        }`
      )
      return null
    }
    if (!fs.existsSync(venvPython)) {
      console.warn(`[ModuleManager] agent venv 创建后未找到 ${venvPython}，跳过 PATH 注入`)
      return null
    }
  }

  const current = process.env.PATH ?? ''
  return venvBin + path.delimiter + current
}
