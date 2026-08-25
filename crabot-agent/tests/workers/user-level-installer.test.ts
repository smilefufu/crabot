import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  UserLevelInstaller,
  userLevelInstallManifestFor,
  userLevelNpmPrefix,
  type InstallCommandRunner,
} from '../../src/workers/install/user-level-installer.js'
import { resolveUserLevelBinary } from '../../src/workers/cli-binary.js'

describe('UserLevelInstaller', () => {
  it('Claude Code 与 Codex 都使用固定官方 package', () => {
    expect(userLevelInstallManifestFor('claude-code')).toMatchObject({
      packageId: '@anthropic-ai/claude-code', binaryName: 'claude',
    })
    expect(userLevelInstallManifestFor('codex')).toMatchObject({
      packageId: '@openai/codex', binaryName: 'codex',
    })
  })

  it('只向固定用户级 prefix 安装，并以 resolver + --version 收口', async () => {
    const homeDir = path.join(os.tmpdir(), 'crabot-user-install-home')
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const runner: InstallCommandRunner = async (file, args) => {
      calls.push({ file, args })
      return { stdout: args[0] === '--version' ? '0.1.2\n' : '', stderr: '' }
    }
    const installer = new UserLevelInstaller({
      dataRoot: '/tmp/crabot-data',
      homeDir,
      resolveNpmCli: async () => '/fixed/npm-cli.js',
      resolveBinary: async (name) => ({ binary: path.join(homeDir, '.local', 'bin', name), global_detected: false }),
      runCommand: runner,
    })

    await expect(installer.install('codex')).resolves.toEqual({
      impl: 'codex', version: '0.1.2', binaryPath: path.join(homeDir, '.local', 'bin', 'codex'),
    })
    expect(calls).toEqual([
      {
        file: process.execPath,
        args: [
          '/fixed/npm-cli.js', 'install', '--global', '--prefix', userLevelNpmPrefix(homeDir),
          '--registry', 'https://registry.npmjs.org/', '@openai/codex',
        ],
      },
      { file: path.join(homeDir, '.local', 'bin', 'codex'), args: ['--version'] },
    ])
  })

  it('resolver 或 version probe 未通过时不报告安装成功', async () => {
    const installer = new UserLevelInstaller({
      dataRoot: '/tmp/crabot-data',
      homeDir: '/tmp/crabot-user-install-home',
      resolveNpmCli: async () => '/fixed/npm-cli.js',
      resolveBinary: async () => ({ global_detected: true }),
      runCommand: async () => ({ stdout: '', stderr: '' }),
    })

    await expect(installer.install('claude-code')).rejects.toThrow(/no user-level binary/)
  })

  it('同 implementation 的安装互斥，并可取消在途命令', async () => {
    let started!: () => void
    const commandStarted = new Promise<void>((resolve) => { started = resolve })
    const runner: InstallCommandRunner = async (_file, _args, options) => {
      started()
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    }
    const installer = new UserLevelInstaller({
      dataRoot: '/tmp/crabot-data',
      homeDir: '/tmp/crabot-user-install-home',
      resolveNpmCli: async () => '/fixed/npm-cli.js',
      resolveBinary: async () => ({ binary: '/tmp/crabot-user-install-home/.local/bin/codex', global_detected: false }),
      runCommand: runner,
    })

    const first = installer.install('codex')
    await commandStarted
    await expect(installer.install('codex')).rejects.toThrow(/in flight/)
    installer.cancelInFlight('codex')
    await expect(first).rejects.toThrow('cancelled')
  })
})

describe('resolveUserLevelBinary', () => {
  it('无需修改 PATH 也会发现标准用户级 npm bin', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-user-level-resolver-'))
    const homeDir = path.join(root, 'home')
    const dataRoot = path.join(root, 'data')
    const binDir = path.join(homeDir, '.local', 'bin')
    const binary = path.join(binDir, 'fake-cli')
    await fs.mkdir(binDir, { recursive: true })
    await fs.writeFile(binary, '#!/bin/sh\necho fake\n', { mode: 0o755 })
    try {
      await expect(resolveUserLevelBinary('fake-cli', dataRoot, { homeDir, pathEnv: '/usr/bin' })).resolves.toEqual({
        binary: await fs.realpath(binary),
        global_detected: false,
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('仍拒绝位于 Crabot data 目录的伪用户级 binary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-user-level-data-'))
    const homeDir = path.join(root, 'home')
    const dataRoot = path.join(homeDir, '.crabot', 'data')
    const binDir = path.join(dataRoot, 'bin')
    await fs.mkdir(binDir, { recursive: true })
    await fs.writeFile(path.join(binDir, 'fake-cli'), '#!/bin/sh\necho fake\n', { mode: 0o755 })
    try {
      await expect(resolveUserLevelBinary('fake-cli', dataRoot, { homeDir, pathEnv: binDir })).resolves.toEqual({
        global_detected: true,
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
