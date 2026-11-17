import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import { spawn, execSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import { BrowserManager } from './browser-manager.js'

vi.mock('fs', () => ({ existsSync: vi.fn() }))
vi.mock('fs/promises', () => ({ default: { readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() } }))
vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn() }))
const platform = process.platform
let child: ChildProcess
let manager: BrowserManager

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('LOCALAPPDATA', 'F:\\用户 空间\\AppData\\Local')
  vi.stubEnv('ProgramFiles', 'G:\\Program Files')
  vi.stubEnv('ProgramFiles(x86)', 'G:\\Program Files (x86)')
  vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))
  vi.mocked(fs.mkdir).mockResolvedValue(undefined)
  vi.mocked(fs.writeFile).mockResolvedValue(undefined)
  child = Object.assign(new EventEmitter(), { pid: 420001, unref: vi.fn(), kill: vi.fn() }) as unknown as ChildProcess
  vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child })
  manager = new BrowserManager(path.join('fixture data', '用户'), 100)
  vi.spyOn(manager, 'isAlive').mockReturnValue(false)
  vi.spyOn(manager, 'isCdpReady').mockResolvedValueOnce(false).mockResolvedValue(true)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.useRealTimers()
})

function chromeAt(root: string, product = 'Google\\Chrome') {
  const binary = path.win32.join(root, product, 'Application', 'chrome.exe')
  vi.mocked(existsSync).mockImplementation(p => p === binary)
  return binary
}

describe('Windows managed Chrome/CDP', () => {
  it.each(['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'])('discovers Chrome under %s and launches an isolated profile without a shell', async env => {
    const binary = chromeAt(process.env[env]!)
    await expect(manager.ensureRunning()).resolves.toBe('http://127.0.0.1:9322')
    expect(spawn).toHaveBeenCalledWith(binary, [
      '--remote-debugging-port=9322',
      `--user-data-dir=${path.join('fixture data', '用户', 'browser', 'profile')}`,
      '--no-first-run', '--no-default-browser-check',
    ], expect.objectContaining({ detached: true, stdio: 'ignore' }))
    expect(execSync).not.toHaveBeenCalled()
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('chrome.pid'), '420001', 'utf-8')
  })

  it('discovers Chromium and reports missing installations honestly', async () => {
    chromeAt(process.env.LOCALAPPDATA!, 'Chromium')
    await expect(manager.ensureRunning()).resolves.toContain('9322')
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(manager.isCdpReady).mockReset().mockResolvedValue(false)
    await expect(manager.ensureRunning()).rejects.toThrow('Chrome/Chromium not found')
  })

  it('reports spawn failure without writing an undefined PID', async () => {
    chromeAt(process.env.LOCALAPPDATA!)
    Object.assign(child, { pid: undefined })
    vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('error', new Error('ENOENT: chrome disappeared'))); return child })
    await expect(manager.ensureRunning()).rejects.toThrow('ENOENT: chrome disappeared')
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('reports shared-profile failure without killing user Chrome', async () => {
    chromeAt(process.env.LOCALAPPDATA!)
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ profile_mode: 'user', cdp_port: 9222 }))
    vi.mocked(manager.isCdpReady).mockReset().mockResolvedValue(false)
    vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0, null) }); return child })
    const pending = expect(manager.ensureRunning()).rejects.toThrow(/profile.*isolated/i)
    await vi.advanceTimersByTimeAsync(16_000)
    await pending
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([
      `--user-data-dir=${path.win32.join(process.env.LOCALAPPDATA!, 'Google', 'Chrome', 'User Data')}`,
    ]), expect.any(Object))
    expect(execSync).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('bounds CDP readiness waiting and explains user-profile restrictions', async () => {
    chromeAt(process.env.LOCALAPPDATA!)
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ profile_mode: 'user', cdp_port: 9222 }))
    vi.mocked(manager.isCdpReady).mockReset().mockResolvedValue(false)
    const pending = expect(manager.ensureRunning()).rejects.toThrow(/profile.*isolated/i)
    await vi.advanceTimersByTimeAsync(16_000)
    await pending
    expect(execSync).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(fs.unlink).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'])('preserves isolated startup on %s', async platform => {
    Object.defineProperty(process, 'platform', { value: platform })
    const binary = platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium'
    vi.mocked(existsSync).mockImplementation(p => p === binary)
    vi.mocked(execSync).mockImplementation(command => {
      if (command === 'which chromium') return binary
      throw new Error('not found')
    })
    await expect(manager.ensureRunning()).resolves.toContain('9322')
    expect(spawn).toHaveBeenCalledWith(binary, expect.any(Array), expect.any(Object))
  })
})
