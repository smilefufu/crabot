// Test-only compilation with the same installed compiler as build-native.mjs.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runBounded } from '../../run-bounded.mjs'
const exec = promisify(execFile)
export async function buildReferenceHolder(directory) {
  const source = fileURLToPath(new URL('program-reference-holder.cc', import.meta.url))
  const executable = path.join(directory, process.platform === 'win32' ? 'holder.exe' : 'holder')
  if (process.platform !== 'win32') {
    await runBounded(process.env.CXX || 'c++', ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable], { cwd: directory, timeout: 30000 })
    return { executable }
  }
  const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe')
  const { stdout } = await exec(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { timeout: 15000 })
  const installation = stdout.trim(); if (!installation || installation.includes('\n')) throw new Error('Installed Microsoft compiler unavailable')
  const library = path.join(directory, 'reference.dll'), script = path.join(directory, 'compile.cmd')
  await fs.writeFile(script, '@echo off\r\ncall "%CRABOT_REFERENCE_VS%\\Common7\\Tools\\VsDevCmd.bat" -arch=x64 >nul\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl.exe /nologo /MT /EHsc /O2 /std:c++17 "%CRABOT_REFERENCE_SOURCE%" /link /OUT:"%CRABOT_REFERENCE_EXE%"\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl.exe /nologo /LD /MT /EHsc /O2 /std:c++17 /DCRABOT_REFERENCE_DLL "%CRABOT_REFERENCE_SOURCE%" /link /OUT:"%CRABOT_REFERENCE_DLL%"\r\n')
  await runBounded('cmd.exe', ['/d', '/s', '/c', script], { cwd: directory, timeout: 60000,
    env: { ...process.env, CRABOT_REFERENCE_VS: installation, CRABOT_REFERENCE_SOURCE: source, CRABOT_REFERENCE_EXE: executable, CRABOT_REFERENCE_DLL: library } })
  return { executable, library }
}
