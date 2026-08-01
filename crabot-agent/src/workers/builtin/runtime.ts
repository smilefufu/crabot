/**
 * builtin worker 的运行环境契约(PR F 第 1 步)。
 *
 * 这里只放"harness / adapter 两侧都要认的东西":起化身时现取运行配置的工厂签名、
 * F 阶段的固定权限档位、worker 必须装的 hook、以及 worker 工具集里绝对不许出现的工具。
 * 真正的运行配置装配(LLM adapter / model / systemPrompt / tools)在生产侧由
 * `unified-agent` 实现该工厂(PR F 第 2 步),本文件不关心它怎么造。
 *
 * @see crabot-docs/superpowers/specs/2026-08-01-builtin-worker-injection-design.md
 */
import type { ResolvedPermissions, ToolAccessConfig, CliAccessConfig, CliDomain, CliPerm } from '../../types.js'
import { CLI_DOMAINS } from '../../types.js'
import { HookRegistry } from '../../hooks/hook-registry.js'
import {
  createCliPermissionHook,
  createSkillDirFenceHook,
  createGitWriteFenceHook,
} from '../../hooks/defaults.js'
import type { SpawnSpec, Workspace } from '../types.js'
import type { LedgerWorker } from '../harness/ledger-types.js'

/**
 * 起化身时喂给运行配置工厂的 per-worker 上下文(spec 决策 1)。
 *
 * 无参签名装不下 per-worker 维度:workspace 决定工具的 cwd、origin 决定(J 之后的)权限
 * 身份、worker_id 决定 bg entity / tmp-page 等的归属——它们都是 spawn 时才知道的。
 *
 * `origin` 声明为可选:生产路径(harness.spawnWorker / handoffIncarnation)恒有值,直接
 * 构造 `SpawnSpec` 的契约套件与单测可能没有台账语境。工厂实现须自行决定缺省时的行为。
 */
export interface BuiltinRuntimeContext {
  readonly worker_id: string
  readonly workspace: Workspace
  readonly origin?: LedgerWorker['origin']
  readonly goal?: string
}

/**
 * 运行配置工厂:每次起化身现调一次(spec 决策 2)。
 *
 * 三个后果:(1) 工厂挂在装配层、跨进程重启仍在,builtin worker 因此能 revive;
 * (2) 改了 model slot 下次起化身生效、正在跑的 burst 用旧的,与 cc/codex 的
 * "下次起化身生效"对齐;(3) LLM 连接信息不落盘。
 */
export type BuiltinRuntimeFactory = (ctx: BuiltinRuntimeContext) => SpawnSpec['builtin']

function cliAccess(perm: 'none' | 'read' | 'write'): CliAccessConfig {
  return Object.fromEntries(CLI_DOMAINS.map((d: CliDomain) => [d, perm])) as CliAccessConfig
}

const WORKER_TOOL_ACCESS: ToolAccessConfig = {
  // 干活必需:读写文件、跑 shell、用 skill / 外部 MCP、查记忆。
  memory: true,
  mcp_skill: true,
  file_io: true,
  shell: true,
  browser: true,
  // v3:worker 不直接跟人类说话(spec 决策 5),messaging 工具本就不装,这里再关一道。
  messaging: false,
  // admin task 域在 v3 由台账取代,worker 不该再写它。
  task: false,
  // 需要身份背书的高危面:没有可信发起人身份之前一律关。
  remote_exec: false,
  desktop: false,
}

/**
 * F 阶段的固定权限档位(所有 builtin worker 同权限)。
 *
 * **J 必须接真实身份。** 现网系统派工(`handleStartTask` / scheduled)拿的是 admin 解析出的
 * `master_private`——那条路径的发起人是系统自身,可信。v3 的 builtin worker 由 manager 代
 * 任意会话发起人派活,而 `LedgerWorker.origin.creator_friend_id` 现网恒空(遗漏项 N1),
 * 拿不到可信身份。因此这里**不照抄 master_private**:
 *   - tool_access 只开"干活必需"的面,`remote_exec`/`desktop` 这类需要身份背书的一律关;
 *   - cli_access 全 `none` —— 放开等于让任何人都能借 worker 改 crabot 自身配置;
 *   - storage 为 null(agent 侧当前无消费方),memory_scopes 为空。
 * cutover(PR J)必须改成按 `origin.creator_friend_id` 实时解析权限模板,并把
 * "worker 权限随发起人身份解析"写进验收——否则群里任何人都能让 worker 干 master 才该
 * 能干的事(spec §"权限身份 → J 必须接线")。
 */
export const BUILTIN_WORKER_PERMISSIONS: ResolvedPermissions = {
  tool_access: WORKER_TOOL_ACCESS,
  cli_access: cliAccess('none'),
  storage: null,
  memory_scopes: [],
}

const CLI_PERM_RANK: Record<CliPerm, number> = { none: 0, read: 1, write: 2 }

/**
 * worker 档位 ∩ 发起人档位（P7 J）—— "manager 算好结果随 spawn 下传"的合并规则。
 *
 * **取交集，不取替换。** 两个方向都必须守住：
 * - 只用发起人档位 ⇒ 一个 master 发起的 worker 会拿到 `messaging: true`，违反 v3
 *   "worker 不直接跟人类说话"（`WORKER_TOOL_ACCESS` 把 messaging/task 关死正是为此）；
 * - 只用 worker 固定档位 ⇒ 群里任何人派出的 worker 都拿到同一套 `shell/file_io`，
 *   这正是 PR F spec 点名要 J 修掉的越权（"群里任何人都能让 worker 干 master 的活"）。
 *
 * 逐项规则：
 * - `tool_access`：按类目**与**（两边都允许才允许）；
 * - `cli_access`：按域取**更严**的那一档（none < read < write）；
 * - `storage`：保留 worker 侧（null）——worker 的落盘边界是 workspace，不随发起人变；
 * - `memory_scopes`：**取发起人的**。它不是能力开关而是可见范围，正是要按发起人身份收敛的
 *   那一项（群 A 的内容不该落成群 B 读得到的记忆）。
 *
 * `principal` 为 null（身份未解析）时原样返回 worker 固定档位，与 F 阶段行为逐字相同。
 */
export function narrowWorkerPermissions(
  base: ResolvedPermissions,
  principal: ResolvedPermissions | null,
): ResolvedPermissions {
  if (!principal) return base

  const tool_access = Object.fromEntries(
    (Object.keys(base.tool_access) as Array<keyof ToolAccessConfig>).map((k) => [
      k,
      base.tool_access[k] && principal.tool_access[k],
    ]),
  ) as unknown as ToolAccessConfig

  const cli_access = Object.fromEntries(
    CLI_DOMAINS.map((d: CliDomain) => [
      d,
      CLI_PERM_RANK[base.cli_access[d]] <= CLI_PERM_RANK[principal.cli_access[d]]
        ? base.cli_access[d]
        : principal.cli_access[d],
    ]),
  ) as CliAccessConfig

  return { tool_access, cli_access, storage: base.storage, memory_scopes: [...principal.memory_scopes] }
}

/**
 * worker 必须装的 hook(spec 决策 6)。
 *
 * **工具面过滤挡不住 worker 在 Bash 里直接跑 `crabot` 写命令** —— 权限过滤只保证"工具不
 * 出现在列表里",CLI 是从 Bash 里调出去的,唯一的闸口是 PreToolUse hook。三条:
 *   - cli-permission-gate:按 `cli_access` 判 `crabot` 子命令(--reveal / 未识别子命令一律拦);
 *   - skill-dir-fence:禁止写 skill 目录;
 *   - git-write-fence:git MCP 的写操作闸。
 */
export function createBuiltinWorkerHookRegistry(): HookRegistry {
  const registry = new HookRegistry()
  registry.registerAll([createCliPermissionHook(), createSkillDirFenceHook(), createGitWriteFenceHook()])
  return registry
}

/**
 * builtin worker 的工具集里绝对不许出现的工具(spec 决策 3 / 决策 4)。
 *
 * - `set_cwd`:worker 的工作目录就是它的 workspace,不可中途切换——否则 §5.4"workspace 是
 *   跨实现交接的唯一介质"对 builtin 不成立(交接时拿到的 workspace 里可能什么都没有);
 * - `set_task_goal`:v3 不给 builtin worker 装 goal 模式,目标驱动靠 prompt 指令表达。
 *
 * 二者在 engine 侧都是"不传上下文就不注册"的可选工具,正常装配根本不会出现;这里做成
 * adapter 侧的硬断言,是因为装配层(PR F 第 2 步)与 adapter 分属两处,只靠约定会漂。
 * engine 里这两个工具的代码**不删**——现网 worker loop 还在用。
 */
export const FORBIDDEN_WORKER_TOOLS: ReadonlySet<string> = new Set(['set_cwd', 'set_task_goal'])
