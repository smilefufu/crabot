/**
 * 渠道实例 module_id 校验（协议 crabot-module-spec.md §4.3）。
 *
 * 实例名即 MM 运行时 module_id，会出现在日志文件名、配置文件名、数据目录、
 * REST URL 路径段、备份 zip 条目名中。白名单：Unicode 小写字母及无大小写
 * 文字（中日韩等）/数字/连字符，2-50 码点；存储前 NFC 归一化。
 * 英文限小写：大小写不敏感文件系统上 Foo 与 foo 会撞文件名。
 *
 * 注意与实现包 module_id（^[a-z0-9-]{3,50}$，module-validator.ts）区分，
 * 后者规则不变。
 */
export const INSTANCE_ID_REGEX = /^[\p{Ll}\p{Lo}\p{N}-]{2,50}$/u

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

/**
 * 文件系统碰撞键：在大小写不敏感文件系统（macOS/Windows）上会折叠到同一文件名的
 * 实例 id 返回同一键。用于查重，防止如 `aσ` / `aς`（都大写为 `Σ`）落到同一
 * `<id>.json` 互相覆盖配置——仅 NFC 归一化挡不住大小写折叠。
 * 查重专用，不作为存储 id。
 */
export function instanceIdFoldKey(id: string): string {
  return id.normalize('NFC').toUpperCase()
}
