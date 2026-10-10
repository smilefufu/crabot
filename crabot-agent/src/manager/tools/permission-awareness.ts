import { effectiveToolAccess } from 'crabot-shared'
/** 模型可见的主体授权；历史兼容字段不进入自我认知。 */
export function stringifyPermissionAwareness(value: unknown): string {
  return JSON.stringify(value, (key, item) => {
    if (key !== 'tool_access' || item === null || typeof item !== 'object' || Array.isArray(item)) return item
    return effectiveToolAccess(item)
  })
}
