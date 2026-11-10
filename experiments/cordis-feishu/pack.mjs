import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pack } from '../../scripts/pack-channel-feishu.mjs'
export { pack }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await pack(path.resolve(process.argv[2] ?? 'artifacts')), null, 2))
}
