export interface NavigationItem { to: string; label: string; match?: string }
export interface NavigationGroup {
  id: string
  label: string
  hint: string
  items: NavigationItem[]
  advanced?: NavigationItem[]
}

export const navigationGroups: NavigationGroup[] = [
  { id: 'chat', label: '聊天', hint: '说说话，也一起做事', items: [{ to: '/chat', label: '聊天' }] },
  { id: 'tasks', label: '任务与计划', hint: '进展、记录与定时安排', items: [
    { to: '/traces', label: '任务记录' }, { to: '/schedules', label: '计划任务' },
  ] },
  { id: 'workspace', label: '工作区', hint: '项目与工作文件', items: [{ to: '/workspaces', label: '工作区列表' }] },
  { id: 'memory', label: '记忆', hint: '记住的事与相处经历', items: [
    { to: '/memory/long-term', label: '长期记忆' }, { to: '/memory/short-term', label: '近期上下文' }, { to: '/memory/scenes', label: '人物与场景' },
  ] },
  { id: 'abilities', label: '本领', hint: '模型、技能与工具', items: [
    { to: '/providers', label: '模型服务' }, { to: '/skills', label: '技能' },
    { to: '/mcp-servers', label: '工具与应用' }, { to: '/subagents', label: '专长助手' },
  ], advanced: [{ to: '/agents/config', label: '模型分工与能力设置' }, { to: '/agents/workers', label: '执行方式' }] },
  { id: 'social', label: '社交', hint: '聊天方式、联系人与权限', items: [
    { to: '/dialog-objects', label: '联系人与群聊' }, { to: '/channels/config', match: '/channels', label: '聊天方式' },
    { to: '/permission-templates', label: '访问规则' },
  ] },
  { id: 'settings', label: '设置', hint: '设备、数据与运行维护', items: [
    { to: '/settings', label: '通用' }, { to: '/desktop/permissions', label: '设备与授权' },
    { to: '/backup', label: '数据管理' }, { to: '/modules', label: '诊断与维护' },
  ], advanced: [{ to: '/migrate/openclaw', label: '导入数据' }, { to: '/desktop/diagnostics', label: '设备诊断' }] },
]

export function matchesNavigation(path: string, item: NavigationItem): boolean {
  const prefix = item.match ?? item.to
  return path === prefix || path.startsWith(prefix + '/')
}

export function navigationForPath(path: string): NavigationGroup | undefined {
  return navigationGroups.find(group => [...group.items, ...(group.advanced ?? [])].some(item => matchesNavigation(path, item)))
}
