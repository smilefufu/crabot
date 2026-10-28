import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect } from 'vitest'

export async function expectPrivateRuntimeFile(file: string, privateRoot: string): Promise<void> {
  expect((await fs.lstat(file)).isFile()).toBe(true)
  if (process.platform !== 'win32') {
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    return
  }
  expect(require('../../../scripts/lib/process-identity.cjs').isPrivateDirectory(privateRoot)).toBe(true)
  const relative = path.relative(await fs.realpath(privateRoot), await fs.realpath(file))
  expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy()
  // Elevated Windows creates inherited files with Administrators as owner.
  // Verify the actual access rules and private ancestor, not POSIX ownership.
  const script = `
    $ErrorActionPreference = 'Stop'
    $env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $env:CRABOT_TEST_PRIVATE_FILE
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ current = ($_.IdentityReference.Value -eq $current); allow = ($_.AccessControlType -eq 'Allow'); rights = [int]$_.FileSystemRights }
    })
    ConvertTo-Json -InputObject $rules -Compress
  `
  const rules = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, CRABOT_TEST_PRIVATE_FILE: file },
  })
  expect(JSON.parse(rules)).toEqual([{ current: true, allow: true, rights: 0x1f01ff }])
}
