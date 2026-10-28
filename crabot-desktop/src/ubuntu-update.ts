// Prepared-update readiness only. No first-install commit or business lifecycle.
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { PreparedInstallation } from './installation-entries.js'
import { ensureUbuntuProgramsReady } from './ubuntu-installation.js'
import { probeUbuntuPrograms } from './ubuntu-program-probe.js'
import { runUbuntuProcess, ubuntuDesktopEnvironment } from './ubuntu-process.js'

export async function prepareUbuntuUpdate(prepared: PreparedInstallation, options: {
  signal: AbortSignal
  verifyPrograms: () => Promise<Parameters<typeof probeUbuntuPrograms>[1]['runtime']>
}): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid!() === 0 || process.getuid!() !== process.geteuid!()) {
    throw Object.assign(new Error('Unsupported desktop authorization context'), { code: 'CRABOT_INSTALL_SYSTEM_AUTHORIZATION' })
  }
  options.signal.throwIfAborted()
  await options.verifyPrograms()
  options.signal.throwIfAborted()
  const helper = path.join(prepared.guiRoot, 'resources/crabot-sandbox-helper'), env = ubuntuDesktopEnvironment(process.env)
  const args = [prepared.installRoot, prepared.selection.gui_id]
  const inspected = await runUbuntuProcess(helper, ['--inspect-update', ...args], env, 60_000, options.signal)
  if (inspected.code !== 0) throw Object.assign(new Error('Prepared program identity changed'), { code: 'CRABOT_INSTALL_PROGRAM_IDENTITY' })
  await ensureUbuntuProgramsReady({ signal: options.signal,
    probe: async () => {
      const runtime = await options.verifyPrograms()
      await probeUbuntuPrograms(prepared, { runtime, signal: options.signal, browserProbe: path.join(prepared.guiRoot, 'resources/browser-probe.py') })
    },
    authorizationNeeded: async () => (await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() === '1',
    authorize: async () => {
      // Polkit alone supplies PKEXEC_UID. Root executes this verified native
      // binary, never Node/JS, a shell, an arbitrary command or an entry list.
      await options.verifyPrograms()
      const result = await runUbuntuProcess('/usr/bin/pkexec', [helper, '--register-update', ...args], env, 360_000, options.signal)
      if (result.code !== 0) throw Object.assign(new Error('System authorization did not complete'), { code: 'CRABOT_INSTALL_SYSTEM_AUTHORIZATION' })
    },
  })
}
