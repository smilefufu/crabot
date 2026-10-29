import { spawn } from 'node:child_process'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createOperationProgressWindow } from './operation-progress-window.js'

export async function runMacLegacyHandoff(coreRoot: string, sourceRoot: string, dataDir: string, version: string): Promise<void> {
  const load = (name: string): Promise<any> => import(pathToFileURL(path.join(coreRoot, 'scripts/lib', name)).href)
  const { verifyCoreRelease } = await load('core-release.mjs')
  await verifyCoreRelease(coreRoot, { version })
  const product = (await load('product-runtime.cjs')).default
  const identity = (await load('process-identity.cjs')).default
  const runtime = product.loadProductRuntime(coreRoot, { required: true })
  const abort = new AbortController(), progress = createOperationProgressWindow('admission', abort)
  try { await progress.ready; abort.signal.throwIfAborted() }
  catch (error) { progress.close(); throw error }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|USER|LOGNAME|TMPDIR|LANG|LC_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)))
  Object.assign(env, { DATA_DIR: dataDir, CRABOT_HOME: coreRoot, CRABOT_DEV: 'false', CRABOT_PORT_OFFSET: '0', CRABOT_PRODUCT_REQUIRED: '1' })
  const labels: Record<string, string> = { stopping: '正在正常停止旧版服务…', preparing_environment: '正在保留并核验已有工作依赖…', switching: '正在准备数据接入，原目录保留…', converting: '正在转换已保护的数据范围…' }
  const child = spawn(runtime.executables.node, [path.join(coreRoot, 'scripts/mac-adopt-legacy.mjs'), sourceRoot], { cwd: coreRoot, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let critical = false, completed = false, failed: unknown, timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { if (!critical && child.connected) child.send({ type: 'cancel' }, () => {}) }
  abort.signal.addEventListener('abort', cancel)
  if (abort.signal.aborted) cancel()
  child.stderr?.on('data', () => {}) // The role emits only failure codes; no pip/config bodies enter GUI logs.
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        try {
          const peer = identity.inspectProcess(child.pid)
          if (!peer || peer.owner !== identity.inspectProcess(process.pid).owner || realpathSync(peer.executable) !== realpathSync(runtime.executables.node)) throw new Error('接入工作进程身份无法核验。')
        } catch (error) { failed = error; if (child.connected) child.disconnect() }
      })
      child.on('message', (message: any) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) { failed = new Error('接入进度无法核验。'); return }
        if (message.type === 'progress' && Object.keys(message).length === 2 && Object.hasOwn(labels, message.phase)) {
          if (message.phase === 'switching' || message.phase === 'converting') critical = true
          progress.update(labels[message.phase], !critical)
        } else if (message.type === 'failure' && Object.keys(message).length === 2 && typeof message.code === 'string' && /^[A-Z0-9_]{1,128}$/.test(message.code)) {
          let hint = '原数据和保护记录保留，请重新打开Crabot继续检查。'
          if (['CRABOT_BACKUP_SPACE', 'CRABOT_UPDATE_SPACE', 'ENOSPC'].includes(message.code)) hint = '磁盘空间不足，请释放空间后重新打开Crabot继续。'
          else if (message.code === 'CRABOT_DATA_NEWER_THAN_CODE') hint = '已有数据需要更新版Crabot，请换用兼容版本，原数据未清空。'
          else if (message.code.startsWith('CRABOT_LEGACY_PYTHON')) hint = '原Python工作依赖未通过接入核验，原环境和数据已保留，请保留诊断代码。'
          failed = Object.assign(new Error(`旧数据接入未完成。${hint}\n数据：${dataDir}\n诊断代码：${message.code}`), { code: 'CRABOT_MAC_ADMISSION' })
        } else if (message.type === 'handoff' && Object.keys(message).length === 2 && message.result?.dataDir === dataDir
          && message.result.verification_pending === true && typeof message.result.maintenance_id === 'string') completed = true
        else failed = new Error('接入交接结果无法核验。')
      })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0 && completed && !failed) resolve()
        else reject(failed || Object.assign(new Error('旧数据接入尚未完成。请保留原目录，重新打开Crabot继续检查。'), { code: 'CRABOT_MAINTENANCE_PENDING' }))
      })
      timer = setTimeout(() => { failed = new Error('接入等待超时，保护记录保留。'); cancel(); child.kill('SIGTERM') }, 30 * 60_000)
    })
  } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); progress.close() }
}
