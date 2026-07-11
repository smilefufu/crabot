/**
 * 从 URL pathname 提取并解码指定位置的路径段。
 *
 * 实例 module_id 可含中文，客户端按协议对 URL 路径段做 percent-encode，
 * 而 new URL().pathname 不解码；路由取段后必须 decodeURIComponent，
 * 否则 MM 收到 %E5%BE%AE... 找不到模块（协议纪律见 crabot-module-spec.md §4.3）。
 * 无效编码时返回原始段，交由下游按"模块不存在"处理。
 */
export function decodePathSegment(pathname: string, index: number): string {
  const segment = pathname.split('/')[index] ?? ''
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * 解码后的路径段用于文件路径拼接前的安全检查。
 * percent-encoding 解码可能引入 '/'、'\'，拼进 path.join 会逃逸目标目录。
 */
export function isPathSafeSegment(segment: string): boolean {
  return segment.length > 0 && !segment.includes('/') && !segment.includes('\\')
}
