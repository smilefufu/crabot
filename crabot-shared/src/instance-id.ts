/**
 * 渠道实例 module_id 校验（协议 crabot-module-spec.md §4.3）。
 *
 * 实例名即 MM 运行时 module_id，会出现在日志文件名、配置文件名、数据目录、
 * REST URL 路径段、备份 zip 条目名中。白名单：中文/日文汉字（\p{Script=Han}）、
 * 大小写 ASCII 字母、数字、连字符，2-50 码点；存储前 NFC 归一化并保留大小写。
 * 名称合法性与唯一性分开：创建/导入/注册入口忽略大小写查重，防文件系统碰撞。
 * 其余 Unicode 字符范围不扩大，避免引入额外的大小写折叠与 NFC/NFD 文件名问题。
 *
 * 注意与实现包 module_id（^[a-z0-9-]{3,50}$，module-validator.ts）区分，
 * 后者规则不变。
 */
export const INSTANCE_ID_REGEX = /^[\p{Script=Han}A-Za-z0-9-]{2,50}$/u

export type InstanceIdResult = { ok: true; id: string } | { ok: false; reason: string }

export function validateInstanceId(raw: string): InstanceIdResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: '实例名不能为空' }
  }
  const id = raw.normalize('NFC')
  if (!INSTANCE_ID_REGEX.test(id)) {
    return {
      ok: false,
      reason: '实例名可用中文、大小写字母、数字、连字符（2-50 字符）',
    }
  }
  return { ok: true, id }
}
