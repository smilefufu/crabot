// Same OS identity producer used by Core and independent maintenance. Keep
// recorded text and failure/null semantics stable; no caching or stop authority.
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      maxBuffer: 1024 * 1024,
      timeout: 10000,
      windowsHide: true,
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

const WINDOWS_EPOCH_100NS = 116444736000000000n

// Win32_Process.CreationDate is a CIM datetime with microsecond precision. The
// native inspect returns the full FILETIME; truncating the 100ns digit yields
// byte-identical text to the PowerShell producer without starting PowerShell.
function windowsStartIdentityFromFiletime(filetime) {
  const ticks = BigInt(filetime)
  const unix = ticks - WINDOWS_EPOCH_100NS
  const seconds = unix >= 0n ? unix / 10000000n : (unix - 9999999n) / 10000000n
  const micros = (unix - seconds * 10000000n) / 10n
  const iso = new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, '')
  return `win32:${iso}.${micros.toString().padStart(6, '0')}0Z`
}

async function probeWindowsStartIdentity(pid) {
  const process = require('./process-identity.cjs').inspectProcess(pid)
  return process ? windowsStartIdentityFromFiletime(process.started) : null
}

async function probeProcessStartIdentity(pid) {
  if (process.platform === 'linux') return probeLinuxStartIdentity(pid)
  if (process.platform === 'win32') return probeWindowsStartIdentity(pid)
  return probePosixStartIdentity(pid)
}

module.exports = { probeProcessStartIdentity, windowsStartIdentityFromFiletime }
