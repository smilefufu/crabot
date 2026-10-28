// A private parent-to-child locator, never a permission or business CLI command.
import path from 'node:path'
export type RemovalRequest = { installRoot: string; operationId: string; existing: boolean; installerPayload?: string }
const prefix = '--crabot-removal-host='
const fail = (): never => { throw Object.assign(new Error('卸载维护入口参数无效。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
export function removalHostArgument(request: RemovalRequest): string {
  const installer = request && Object.hasOwn(request, 'installerPayload')
  if (!request || Object.keys(request).sort().join(',') !== (installer ? 'existing,installRoot,installerPayload,operationId' : 'existing,installRoot,operationId')
    || installer && (request.existing !== true || typeof request.installerPayload !== 'string' || !path.isAbsolute(request.installerPayload)
      || request.installerPayload.length > 32768 || request.installerPayload.includes('\0'))
    || typeof request.installRoot !== 'string' || !path.isAbsolute(request.installRoot) || request.installRoot.length > 32768 || request.installRoot.includes('\0')
    || typeof request.operationId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(request.operationId) || typeof request.existing !== 'boolean') fail()
  return prefix + Buffer.from(JSON.stringify(request)).toString('base64url')
}
export function readRemovalHostRequest(args: string[]): RemovalRequest | undefined {
  const entries = args.filter(value => value.startsWith('--crabot-removal-host'))
  if (!entries.length) return undefined
  if (args.length !== 2 || entries.length !== 1 || !entries[0].startsWith(prefix)) fail()
  const encoded = entries[0].slice(prefix.length)
  if (!encoded || encoded.length > 131072 || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail()
  let request: RemovalRequest
  try { request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { return fail() }
  if (removalHostArgument(request) !== entries[0]) fail()
  return request
}
