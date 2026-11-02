// Standard Debian configuration files and debhelper-generated AppArmor hooks.
// No installer service, user-data access, or program-version selector.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function ubuntuDebPolicy(runtime) {
  const browsers = Object.keys(runtime.files ?? {}).filter(name =>
    /\/browsers\/(?:chromium-\d+\/chrome-linux(?:64)?\/chrome|chromium_headless_shell-\d+\/chrome-headless-shell-linux(?:64)?\/headless_shell)$/.test(name))
  if (browsers.length !== 2 || browsers.some(name => !/^[a-zA-Z0-9_.\/-]+$/.test(name) || name.split('/').includes('..'))) {
    throw new Error('Expected the two exact bundled Chromium executables')
  }
  return 'abi <abi/4.0>,\ninclude <tunables/global>\n\n' + [
    ['gui', '/opt/Crabot/crabot-desktop'],
    ...browsers.sort().map(name => [name.includes('chromium_headless_shell-') ? 'headless' : 'chromium', '/opt/Crabot/resources/core/' + name]),
  ].map(([role, executable]) => `profile crabot-desktop-${role} "${executable}" flags=(unconfined) {\n  userns,\n}\n`).join('\n')
}

export const ubuntuDebRunningGuard = `#!/bin/sh
set -eu
# Debian preinst runs before any installed program file is overwritten.
for executable in /opt/Crabot/crabot-desktop /opt/Crabot/resources/core/.product-runtime/node/bin/node; do
  if [ -x "$executable" ]; then
    result=0
    /usr/sbin/start-stop-daemon --status --exec "$executable" >/dev/null 2>&1 || result=$?
    case "$result" in
      0) echo 'Crabot 仍在运行。请从应用菜单退出 Crabot 后重新安装或升级；安装器未停止服务、未覆盖程序。' >&2; exit 1 ;;
      1|3) ;;
      *) echo "检查 Crabot 进程失败：start-stop-daemon 返回 $result，尚未覆盖程序。" >&2; exit 1 ;;
    esac
  fi
done
`

export async function prepareUbuntuDeb({ core, resources, directory }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Ubuntu DEB must be built on Linux x64')
  await fs.mkdir(directory)
  const runtime = JSON.parse(await fs.readFile(path.join(core, 'product-runtime.json'), 'utf8'))
  const policy = path.join(directory, 'crabot-desktop')
  await fs.writeFile(policy, ubuntuDebPolicy(runtime))
  // publish:null intentionally disables updates; electron-builder otherwise omits this marker.
  await fs.writeFile(path.join(resources, 'package-type'), 'deb\n')
  const debian = path.join(directory, 'debian')
  await fs.mkdir(debian)
  await fs.writeFile(path.join(debian, 'control'), 'Source: crabot-desktop\nSection: utils\nPriority: optional\nMaintainer: Crabot Team <noreply@github.com>\nStandards-Version: 4.7.0\n\nPackage: crabot-desktop\nArchitecture: amd64\nDescription: Crabot desktop\n')
  await fs.writeFile(path.join(debian, 'compat'), '13\n')
  execFileSync('dh_apparmor', ['--profile-name=crabot-desktop', '-pcrabot-desktop'], { cwd: directory, stdio: 'inherit' })
  const afterInstall = path.join(directory, 'postinst'), afterRemove = path.join(directory, 'postrm')
  await fs.writeFile(afterInstall, '#!/bin/sh\nset -e\n' + await fs.readFile(path.join(debian, 'crabot-desktop.postinst.debhelper'), 'utf8'))
  await fs.writeFile(afterRemove, '#!/bin/sh\nset -e\n' + await fs.readFile(path.join(debian, 'crabot-desktop.postrm.debhelper'), 'utf8'))
  const preinst = path.join(directory, 'preinst'), prerm = path.join(directory, 'prerm')
  await fs.writeFile(preinst, ubuntuDebRunningGuard)
  await fs.writeFile(prerm, ubuntuDebRunningGuard)
  // Package-owned fixed CLI/menu links; dpkg removes them on uninstall.
  const guiLink = path.join(directory, 'crabot-desktop-link'), cliLink = path.join(directory, 'crabot-link')
  await fs.symlink('/opt/Crabot/crabot-desktop', guiLink)
  await fs.symlink('/opt/Crabot/resources/core/bin/crabot', cliLink)
  return {
    packageName: 'crabot-desktop', compression: 'zst', appArmorProfile: policy, afterInstall, afterRemove,
    fpm: ['--before-install', preinst, '--before-remove', prerm, '--config-files', '/etc/apparmor.d/crabot-desktop',
      `${policy}=/etc/apparmor.d/crabot-desktop`, `${guiLink}=/usr/bin/crabot-desktop`, `${cliLink}=/usr/bin/crabot`],
  }
}
