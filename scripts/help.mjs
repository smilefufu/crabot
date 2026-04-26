#!/usr/bin/env node

// Crabot Help — 显示 CLI 命令帮助

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const dim  = (s) => `\x1b[2m${s}\x1b[0m`

const lines = [
  '',
  bold('Crabot') + ' — 模块化 AI 员工平台',
  '',
  bold('生产模式管理'),
  `  ${cyan('crabot start')}              启动 Crabot（前台运行 Module Manager）`,
  `  ${cyan('crabot stop')}               优雅关闭所有服务`,
  `  ${cyan('crabot check')}              检查模块运行状态`,
  `  ${cyan('crabot upgrade')}            升级到最新版本（release 模式）或重装依赖（源码模式）`,
  `  ${cyan('crabot password')}           修改管理员密码`,
  '',
  bold('业务管理（CLI 覆盖 Admin WebUI 全部能力）'),
  `  ${cyan('crabot provider list')}      查看模型供应商`,
  `  ${cyan('crabot agent list')}         查看智能体实例`,
  `  ${cyan('crabot mcp list')}           查看 MCP 服务`,
  `  ${cyan('crabot schedule list')}      查看定时任务`,
  `  ${cyan('crabot channel list')}       查看渠道`,
  `  ${cyan('crabot friend list')}        查看好友`,
  `  ${cyan('crabot config show')}        查看全局配置`,
  `  ${cyan('crabot permission list')}    查看权限模板`,
  '',
  dim('  所有业务命令支持 --json 输出（脚本/AI 调用友好）'),
  dim('  完整子命令列表：crabot <资源名> --help'),
  '',
  bold('开发'),
  `  ${cyan('./dev.sh')}                  启动开发模式（Vite HMR + 自动同步依赖）`,
  `  ${cyan('./install.sh --from-source')} 源码安装（首次或重装环境）`,
  '',
]

console.log(lines.join('\n'))
