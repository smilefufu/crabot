/** 仅用于模型可见的权限结果；未实装类别不进入自我认知，原始授权对象保持不变。 */
export function stringifyPermissionAwareness(value: unknown): string {
  return JSON.stringify(value, (key, item) => {
    if (key !== 'tool_access' || item === null || typeof item !== 'object' || Array.isArray(item)) return item
    const { remote_exec: _remoteExec, ...toolAccess } = item
    return toolAccess
  })
}
