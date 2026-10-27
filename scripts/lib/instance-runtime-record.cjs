const { existsSync, readFileSync, realpathSync } = require('node:fs')
const { join } = require('node:path')

const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_INSTANCE_UNVERIFIED' }) }

// One read schema shared by the ESM lifecycle controller and CommonJS MM entry.
function readInstanceRuntime(dataDir) {
  const file = join(dataDir, 'instance-runtime.json')
  if (!existsSync(file)) return null
  let record
  try { record = JSON.parse(readFileSync(file, 'utf8')) } catch { fail('运行记录损坏；保留现场，请打开诊断。') }
  const validProcess = process => process && Number.isSafeInteger(process.pid) && process.pid > 0
    && ['owner', 'started', 'executable'].every(key => typeof process[key] === 'string' && process[key])
  if (record?.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(record.instance_id)
    || !/^[a-f0-9-]{36}$/.test(record.generation) || typeof record.data_dir !== 'string'
    || typeof record.install_root !== 'string' || !validProcess(record.controller)
    || (record.mm !== null && !validProcess(record.mm))
    || !Number.isInteger(record.mm_port) || record.mm_port < 1 || record.mm_port > 65535) fail('运行记录格式不兼容；未终止任何进程。')
  if (record.data_dir !== realpathSync(dataDir)) fail('运行记录的数据目录不匹配。')
  return record
}

module.exports = { readInstanceRuntime }
