/**
 * SecretRef 解析器
 *
 * 新版 OpenClaw 安装向导（如 @larksuite/openclaw-lark）会把敏感字段
 * 写成引用对象：
 *
 *   "appSecret": { "source": "file", "provider": "lark-secrets", "id": "/lark/appSecret" }
 *
 * 配套的 provider 定义在配置根的 `secrets.providers`：
 *
 *   "secrets": {
 *     "providers": {
 *       "lark-secrets": { "source": "file", "path": "~/.openclaw/credentials/lark.secrets.json" }
 *     }
 *   }
 *
 * 但 channel-host 加载的插件本身（无论 @openclaw/feishu 还是 @larksuite/openclaw-lark）
 * 都期望拿到的是明文字符串，不会自己解析引用 → 飞书 SDK 把对象 toString 后发到
 * /callback/ws/endpoint 直接 400。
 *
 * 这个模块在 plugin_config 喂给插件之前把所有 SecretRef 解析为明文字符串。
 * 老配置（直接内联 string、没有 secrets 段）原样透传，不受影响。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type SecretRefSource = 'file' | 'env' | 'value'

interface SecretRef {
  source: SecretRefSource
  /** Provider 名（仅 source='file' 必需） */
  provider?: string
  /** file 模式下是 JSON pointer 风格路径（如 "/lark/appSecret"）；env 模式下是环境变量名；value 模式下是字面值 */
  id?: string
  /** value 模式下的字面值 */
  value?: string
}

interface ProviderDef {
  source: 'file'
  path: string
}

interface SecretsSection {
  providers?: Record<string, ProviderDef>
}

const FILE_CACHE = new Map<string, unknown>()

function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.source !== 'string') return false
  if (v.source !== 'file' && v.source !== 'env' && v.source !== 'value') return false
  return typeof v.id === 'string' || typeof v.value === 'string'
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (p === '~') return os.homedir()
  return p
}

function loadProviderFile(filePath: string): unknown {
  const resolved = expandHome(filePath)
  const cached = FILE_CACHE.get(resolved)
  if (cached !== undefined) return cached
  const raw = fs.readFileSync(resolved, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  FILE_CACHE.set(resolved, parsed)
  return parsed
}

/**
 * 按 JSON pointer 风格路径取值。
 * "/lark/appSecret" → root.lark.appSecret
 * "appSecret" 也支持（无前导 /）。
 */
function lookupByPointer(root: unknown, pointer: string): unknown {
  const parts = pointer.split('/').filter((p) => p.length > 0)
  let cur: unknown = root
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function resolveOne(ref: SecretRef, secrets: SecretsSection | undefined, fieldPath: string): string {
  if (ref.source === 'value') {
    if (typeof ref.value !== 'string') {
      throw new Error(`SecretRef at ${fieldPath}: source='value' 但 value 不是字符串`)
    }
    return ref.value
  }

  if (ref.source === 'env') {
    if (!ref.id) throw new Error(`SecretRef at ${fieldPath}: source='env' 必须提供 id（环境变量名）`)
    const v = process.env[ref.id]
    if (!v) throw new Error(`SecretRef at ${fieldPath}: 环境变量 ${ref.id} 未设置`)
    return v
  }

  // source === 'file'
  if (!ref.provider) throw new Error(`SecretRef at ${fieldPath}: source='file' 必须提供 provider 名`)
  if (!ref.id) throw new Error(`SecretRef at ${fieldPath}: source='file' 必须提供 id（JSON pointer 路径）`)
  const provider = secrets?.providers?.[ref.provider]
  if (!provider) {
    throw new Error(
      `SecretRef at ${fieldPath}: 找不到 provider '${ref.provider}'，请确认 secrets.providers 段已配置`
    )
  }
  if (provider.source !== 'file' || !provider.path) {
    throw new Error(`SecretRef at ${fieldPath}: provider '${ref.provider}' 配置无效（仅支持 source='file'）`)
  }
  const fileContent = loadProviderFile(provider.path)
  const value = lookupByPointer(fileContent, ref.id)
  if (typeof value !== 'string') {
    throw new Error(
      `SecretRef at ${fieldPath}: 在 ${provider.path} 的 ${ref.id} 处未找到字符串值（实际：${typeof value}）`
    )
  }
  return value
}

function walk(node: unknown, secrets: SecretsSection | undefined, fieldPath: string): unknown {
  if (isSecretRef(node)) {
    return resolveOne(node, secrets, fieldPath)
  }
  if (Array.isArray(node)) {
    return node.map((item, i) => walk(item, secrets, `${fieldPath}[${i}]`))
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v, secrets, fieldPath ? `${fieldPath}.${k}` : k)
    }
    return out
  }
  return node
}

/**
 * 解析配置中所有 SecretRef 对象为明文字符串。
 *
 * - 不修改入参（深拷贝 + 替换）
 * - 老配置（无 SecretRef）原样透传
 * - 解析失败立即抛错，避免插件拿到对象后给飞书 SDK 导致难以诊断的 400
 *
 * 注意：`secrets.providers[*]` 段本身不会被误识别为 SecretRef，因为 provider 定义
 * 用的是 `path` 字段（不是 `id`/`value`）。
 */
export function resolveSecretRefs(cfg: unknown): unknown {
  if (!cfg || typeof cfg !== 'object') return cfg
  const root = cfg as Record<string, unknown>
  const secrets = root.secrets as SecretsSection | undefined
  return walk(root, secrets, '')
}

/** 测试用：清掉文件读取缓存（实例级 cache 让 secret 文件改了立即生效需要重启进程） */
export function _clearSecretFileCache(): void {
  FILE_CACHE.clear()
}
