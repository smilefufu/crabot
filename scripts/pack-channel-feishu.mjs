import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pack as packChannel } from './pack-channel.mjs'
export const pack = destination => packChannel('feishu', destination)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await pack(path.resolve(process.argv[2] ?? 'artifacts')), null, 2))
}
