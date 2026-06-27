import path from 'node:path'
import fs from 'node:fs'
import type { ModuleDefinition } from 'crabot-shared'

export interface BuildCoreModulesOpts {
  crabotRoot: string
  adminDir: string
  agentDir: string
  memoryDir: string
  dataDir: string          // 顶层 DATA_DIR
  workspaceDir: string
  isDev: boolean
  port: number
  adminRpcPort: string
  adminWebPort: string
  mmEndpoint: string
  adminEndpoint: string
  newApiToken: string
  enableFda: string
}

type CoreModule = ModuleDefinition & Record<string, unknown>

export function buildCoreModules(o: BuildCoreModulesOpts): CoreModule[] {
  const modules: CoreModule[] = [
    {
      module_id: 'admin-web',
      module_type: 'admin',
      version: '0.1.0',
      protocol_version: '0.1.0',
      entry: o.isDev ? 'npx tsx --watch src/main.ts' : 'node dist/main.js',
      cwd: o.adminDir,
      auto_start: o.isDev || fs.existsSync(path.join(o.adminDir, 'dist', 'main.js')),
      auto_restart: true,
      start_priority: 10,
      env: {
        CRABOT_ADMIN_PORT: o.adminRpcPort,
        CRABOT_ADMIN_WEB_PORT: o.adminWebPort,
        CRABOT_MM_ENDPOINT: o.mmEndpoint,
        CRABOT_MM_PORT: String(o.port),
        // DATA_DIR 全局=顶层；admin 模块级目录走专用 env（与 memory 对称）
        DATA_DIR: o.dataDir,
        CRABOT_ADMIN_DATA_DIR: path.join(o.dataDir, 'admin'),
      } as Record<string, string>,
    },
    {
      module_id: 'crabot-agent',
      module_type: 'agent',
      version: '0.2.0',
      protocol_version: '0.2.0',
      entry: 'node --max-old-space-size=2048 --heapsnapshot-near-heap-limit=3 --heapsnapshot-signal=SIGUSR2 dist/main.js',
      cwd: o.agentDir,
      auto_start: fs.existsSync(path.join(o.agentDir, 'dist', 'main.js')),
      auto_restart: true,
      start_priority: 20,
      env: {
        CONFIG_PATH: path.join(o.agentDir, 'config.yaml'),
        // DATA_DIR 全局=顶层；agent 模块级目录走专用 env
        DATA_DIR: o.dataDir,
        CRABOT_AGENT_DATA_DIR: path.join(o.dataDir, 'agent'),
        WORKSPACE_DIR: o.workspaceDir,
        // 传递 New API token 给 Agent 使用
        NEW_API_TOKEN: o.newApiToken,
        // 传递 Admin endpoint，用于从 Admin 获取配置
        CRABOT_ADMIN_ENDPOINT: o.adminEndpoint,
        CRABOT_MM_ENDPOINT: o.mmEndpoint,
        CRABOT_MM_PORT: String(o.port),
        CRABOT_MODULE_ID: 'crabot-agent',
        // macOS FDA 意图开关：透传给 agent，决定 glob/grep 是否放开扫描 ~/Library
        // 等受保护目录（仍需进程真正持有「完全磁盘访问权限」才生效，见 fda-check.ts）。
        CRABOT_ENABLE_FDA: o.enableFda,
        // agent 的 restart_instance 工具用 CRABOT_HOME 定位 scripts/restart.mjs
        CRABOT_HOME: o.crabotRoot,
      } as Record<string, string>,
    },
    {
      module_id: 'memory-default',
      module_type: 'memory',
      version: '0.1.0',
      protocol_version: '0.1.0',
      entry: 'uv run --frozen python -m src.main',
      cwd: o.memoryDir,
      data_dir: path.join(o.dataDir, 'memory'),
      auto_start: fs.existsSync(path.join(o.memoryDir, 'src', 'main.py')),
      auto_restart: true,
      start_priority: 15,  // 在 admin(10) 之后启动，确保配置已就绪
      env: {
        CRABOT_MEMORY_DATA_DIR: path.join(o.dataDir, 'memory'),
        CRABOT_MODULE_MANAGER_URL: o.mmEndpoint,
        CRABOT_MM_PORT: String(o.port),
        // Admin endpoint，供 Memory 模块启动时 pull 初始配置
        CRABOT_ADMIN_ENDPOINT: o.adminEndpoint,
        // LLM/Embedding 配置由 Admin 在 Memory 启动后通过 RPC push 注入
        // 空字符串表示"未配置"，Memory 模块的 is_configured() 会检测到
      } as Record<string, string>,
    },
  ]

  // CRABOT_DEV=true 时注册 Vite 前端开发服务器，由 MM 统一管理
  if (o.isDev) {
    modules.push({
      module_id: 'vite-dev',
      module_type: 'devtool',
      entry: 'npx vite --port {PORT} --clearScreen false',
      cwd: path.join(o.adminDir, 'web'),
      auto_start: true,
      start_priority: 30,  // Admin(10), Agent(20) 之后
      skip_health_check: true,
      env: {} as Record<string, string>,
    })
  }

  return modules
}
