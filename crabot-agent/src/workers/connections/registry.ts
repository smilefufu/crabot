/**
 * 固定 translator 注册表（P6-B plan §2 支持矩阵）。
 *
 * CLI 注入事实（2026-08-14 probe，见 plans/2026-08-14-p6-b-cli-probe-notes.md）：
 * - claude-code 2.1.227：`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL` env 注入；
 *   `claude setup-token` 为固定 native setup 命令。
 * - codex 0.146.0：隔离 CODEX_HOME + config.toml `[model_providers.*]`（wire_api/base_url/env_key）；
 *   `codex login`（device-auth）为固定 native setup 命令。
 *
 * CLI 版本不作为 translator gate；上游变更由 verify/实际执行报告。
 */

import type { ConnectionTranslator, ResolvedWorkerConnection, TranslatorInjection } from './types.js'
import type { CLIWorkerImplId, WorkerConnectionCapability } from '../types.js'

abstract class BaseTranslator implements ConnectionTranslator {
  abstract readonly impl: CLIWorkerImplId
  abstract readonly capability: WorkerConnectionCapability & { mode: NonNullable<WorkerConnectionCapability['mode']> }

  protected assertConnection(connection: ResolvedWorkerConnection | undefined): ResolvedWorkerConnection {
    if (!connection?.endpoint || !connection.apikey || !connection.model_id || !connection.format) {
      throw new Error(`translator ${this.capability.translator_id} requires a fully resolved admin_provider connection`)
    }
    const formats = this.capability.provider_formats
    if (formats && !formats.includes(connection.format)) {
      throw new Error(`translator ${this.capability.translator_id} does not support provider format ${connection.format}`)
    }
    return connection
  }

  abstract buildInjection(input: { connection?: ResolvedWorkerConnection }): TranslatorInjection
}

// ── claude-code ────────────────────────────────────────────────────────────

/** admin_provider → ANTHROPIC_* env（仅 anthropic format）。 */
class ClaudeCodeAnthropicRuntimeV1 extends BaseTranslator {
  readonly impl = 'claude-code' as const
  readonly capability: WorkerConnectionCapability & { mode: 'admin_provider' } = {
    mode: 'admin_provider',
    translator_id: 'claude-code-anthropic-runtime-v1',
    translator_version: '1',
    provider_formats: ['anthropic'],
    endpoint_policy: 'custom_base_url',
    credential_transport: 'process_env',
    model_selection: 'explicit_model',
    credential_scope: 'admin_runtime',
  }

  buildInjection(input: { connection?: ResolvedWorkerConnection }): TranslatorInjection {
    const connection = this.assertConnection(input.connection)
    return {
      env: {
        ANTHROPIC_BASE_URL: connection.endpoint!,
        ANTHROPIC_AUTH_TOKEN: connection.apikey!,
        ANTHROPIC_MODEL: connection.model_id!,
      },
    }
  }
}

/** existing_host：用当前运行用户的 host config，不注入任何 credential。 */
class ClaudeCodeExistingHostV1 extends BaseTranslator {
  readonly impl = 'claude-code' as const
  readonly capability: WorkerConnectionCapability & { mode: 'existing_host' } = {
    mode: 'existing_host',
    translator_id: 'claude-code-existing-host-v1',
    translator_version: '1',
    credential_transport: 'native_store',
    model_selection: 'native_default',
    credential_scope: 'runtime_user_home',
  }

  buildInjection(): TranslatorInjection {
    return { env: {} }
  }
}

/** native_account：setup-token 登录后的 CLI 原生 store，不注入。 */
class ClaudeCodeNativeAccountV1 extends BaseTranslator {
  readonly impl = 'claude-code' as const
  readonly capability: WorkerConnectionCapability & { mode: 'native_account' } = {
    mode: 'native_account',
    translator_id: 'claude-code-native-account-v1',
    translator_version: '1',
    credential_transport: 'native_store',
    model_selection: 'native_default',
    credential_scope: 'managed',
  }

  buildInjection(): TranslatorInjection {
    return { env: {} }
  }
}

// ── codex ──────────────────────────────────────────────────────────────────

/** admin_provider → 隔离 CODEX_HOME 的 config.toml model_providers + env_key 引用。 */
class CodexOpenAIResponsesRuntimeV1 extends BaseTranslator {
  readonly impl = 'codex' as const
  readonly capability: WorkerConnectionCapability & { mode: 'admin_provider' } = {
    mode: 'admin_provider',
    translator_id: 'codex-openai-responses-runtime-v1',
    translator_version: '1',
    provider_formats: ['openai-responses'],
    endpoint_policy: 'custom_base_url',
    credential_transport: 'agent_runtime_file',
    model_selection: 'explicit_model',
    credential_scope: 'admin_runtime',
  }

  /** credential 引用的 env 名固定（值只在本操作的 child env 内存活）。 */
  static readonly ENV_KEY = 'CRABOT_WORKER_ADMIN_PROVIDER_KEY'

  buildInjection(input: { connection?: ResolvedWorkerConnection }): TranslatorInjection {
    const connection = this.assertConnection(input.connection)
    const configToml = [
      'model_provider = "crabot-admin"',
      `model = ${JSON.stringify(connection.model_id!)}`,
      '',
      '[model_providers.crabot-admin]',
      'name = "crabot-admin"',
      'wire_api = "responses"',
      `base_url = ${JSON.stringify(connection.endpoint!)}`,
      `env_key = ${JSON.stringify(CodexOpenAIResponsesRuntimeV1.ENV_KEY)}`,
      '',
    ].join('\n')
    return {
      env: { [CodexOpenAIResponsesRuntimeV1.ENV_KEY]: connection.apikey! },
      runtimeFiles: { 'config.toml': configToml },
    }
  }
}

class CodexExistingHostV1 extends BaseTranslator {
  readonly impl = 'codex' as const
  readonly capability: WorkerConnectionCapability & { mode: 'existing_host' } = {
    mode: 'existing_host',
    translator_id: 'codex-existing-host-v1',
    translator_version: '1',
    credential_transport: 'native_store',
    model_selection: 'native_default',
    credential_scope: 'runtime_user_home',
  }

  buildInjection(): TranslatorInjection {
    return { env: {} }
  }
}

class CodexNativeAccountV1 extends BaseTranslator {
  readonly impl = 'codex' as const
  readonly capability: WorkerConnectionCapability & { mode: 'native_account' } = {
    mode: 'native_account',
    translator_id: 'codex-native-account-v1',
    translator_version: '1',
    credential_transport: 'native_store',
    model_selection: 'native_default',
    credential_scope: 'managed',
  }

  buildInjection(): TranslatorInjection {
    return { env: {} }
  }
}

const ALL_TRANSLATORS: ConnectionTranslator[] = [
  new ClaudeCodeAnthropicRuntimeV1(),
  new ClaudeCodeExistingHostV1(),
  new ClaudeCodeNativeAccountV1(),
  new CodexOpenAIResponsesRuntimeV1(),
  new CodexExistingHostV1(),
  new CodexNativeAccountV1(),
]

/** 固定闭集查询；无匹配表示该 connection mode 尚无 translator。 */
export function findTranslator(impl: CLIWorkerImplId, mode: WorkerConnectionCapability['mode']): ConnectionTranslator | undefined {
  return ALL_TRANSLATORS.find((translator) => translator.impl === impl && translator.capability.mode === mode)
}

/** 某 impl 当前发布的全部 connection capabilities。 */
export function connectionCapabilitiesFor(impl: CLIWorkerImplId): WorkerConnectionCapability[] {
  return ALL_TRANSLATORS
    .filter((translator) => translator.impl === impl)
    .map((translator) => translator.capability)
}
