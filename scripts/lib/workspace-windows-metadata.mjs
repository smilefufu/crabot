// Raw Native Windows metadata is three length-prefixed byte strings: attributes, SD, EAs.
// Removing the SD here proves only the remaining bytes; ACL equivalence is independently checked by Native.
export function workspaceMetadataWithoutSecurity(metadata) {
  if (!Buffer.isBuffer(metadata)) throw new Error('Invalid Windows metadata')
  const parts = []; let at = 0
  while (at < metadata.length && parts.length < 3) {
    const end = metadata.indexOf(58, at), length = metadata.subarray(at, end).toString('ascii')
    if (end < at || !/^(0|[1-9][0-9]*)$/.test(length)) throw new Error('Invalid Windows metadata length')
    const size = Number(length)
    if (!Number.isSafeInteger(size) || end + 1 + size > metadata.length) throw new Error('Incomplete Windows metadata')
    parts.push(metadata.subarray(end + 1, end + 1 + size)); at = end + 1 + size
  }
  if (parts.length !== 3 || at !== metadata.length) throw new Error('Invalid Windows metadata fields')
  return Buffer.concat([Buffer.from(parts[0].length + ':'), parts[0], Buffer.from(parts[2].length + ':'), parts[2]])
}
