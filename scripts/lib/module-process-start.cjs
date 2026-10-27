// Same OS identity producer used by Core and independent maintenance. Keep
// recorded text and failure/null semantics stable; no caching or stop authority.
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function probeLinuxStartIdentity(pid) {
  try {
    const [stat, bootId] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ])
    const commandEnd = stat.lastIndexOf(')')
    const fieldsAfterCommand = commandEnd === -1
      ? []
      : stat.slice(commandEnd + 2).trim().split(/\s+/)
    const startTicks = fieldsAfterCommand[19]
    if (!startTicks) throw new Error(`Cannot parse process start identity for PID ${pid}`)
    return `linux:${bootId.trim()}:${startTicks}`
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function probePosixStartIdentity(pid) {
  try {
    const output = await execFileText('ps', ['-p', String(pid), '-o', 'lstart='])
    const startedAt = output.trim()
    return startedAt ? `${process.platform}:${startedAt}` : null
  } catch (error) {
    if (error.code === 1) return null
    throw error
  }
}

async function probeWindowsStartIdentity(pid) {
  const script = "$ErrorActionPreference='Stop'; "
    + `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; `
    + `if ($null -ne $process) { $process.CreationDate.ToUniversalTime().ToString('o') }`
  const output = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  const startedAt = output.trim()
  return startedAt ? `win32:${startedAt}` : null
}

async function probeProcessStartIdentity(pid) {
  if (process.platform === 'linux') return probeLinuxStartIdentity(pid)
  if (process.platform === 'win32') return probeWindowsStartIdentity(pid)
  return probePosixStartIdentity(pid)
}

module.exports = { probeProcessStartIdentity }
