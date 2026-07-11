/**
 * 渠道实例 module_id 校验（协议 crabot-module-spec.md §4.3）。
 *
 * 实例名即 MM 运行时 module_id，会出现在日志文件名、配置文件名、数据目录、
 * REST URL 路径段、备份 zip 条目名中。白名单刻意收窄为：中文/日文汉字（\p{Script=Han}）、
 * 小写 ASCII 字母、数字、连字符，2-50 码点；存储前 NFC 归一化。
 *
 * 为什么这么窄：Han 无大小写、汉字单码点不分解，故不存在大小写折叠碰撞（如希腊
 * aσ/aς 都大写为 Σ）、也不存在 NFC/NFD 文件名错位（如带重音拉丁 café、韩文 한）。
 * 从字符集层面根除这两类文件系统碰撞，避免在查重 / 备份导入各处打补丁。
 *
 * 注意与实现包 module_id（^[a-z0-9-]{3,50}$，module-validator.ts）区分，
 * 后者规则不变。
 */
export const INSTANCE_ID_REGEX = /^[\p{Script=Han}a-z0-9-]{2,50}$/u

export type InstanceIdResult = { ok: true; id: string } | { ok: false; reason: string }

export function validateInstanceId(raw: string): InstanceIdResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: '实例名不能为空' }
  }
  const id = raw.normalize('NFC')
  if (!INSTANCE_ID_REGEX.test(id)) {
    return {
      ok: false,
      reason: '实例名可用中文、小写字母、数字、连字符（2-50 字符）',
    }
  }
  return { ok: true, id }
}
