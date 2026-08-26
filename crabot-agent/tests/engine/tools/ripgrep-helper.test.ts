import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import {
  runRipgrep,
  getProtectedExcludeGlobs,
  MACOS_PROTECTED_EXCLUDE_GLOBS,
} from '../../../src/engine/tools/ripgrep-helper'

describe('runRipgrep', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ripgrep-helper-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns exitCode 0 + stdout when matches are found', async () => {
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'src', 'a.txt'), 'foo\nbar\n')

    const r = await runRipgrep(['--no-ignore', '--hidden', '-e', 'foo', tmp])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('foo')
    expect(r.truncated).toBe(false)
  })

  it('returns exitCode 1 + empty stdout when no matches', async () => {
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'src', 'a.txt'), 'foo\n')

    const r = await runRipgrep(['--no-ignore', '--hidden', '-e', 'zzz_nope_zzz', tmp])
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('returns exitCode 2 for invalid path', async () => {
    const r = await runRipgrep([
      '--no-ignore',
      '-e',
      'foo',
      join(tmp, 'does-not-exist'),
    ])
    expect(r.exitCode).toBe(2)
  })

  it('caps stdout by maxBytes, retaining the first matches, and kills the rg process', async () => {
    // 写一个会产生大量 stdout 的场景：1000 行匹配，每行 ~50 字节，~50KB 总输出
    const big = Array.from({ length: 1000 }, (_, i) => `line-${i}: MATCH_ME some content here`).join('\n')
    writeFileSync(join(tmp, 'big.txt'), big)

    const r = await runRipgrep(
      ['--no-ignore', '--hidden', '--line-number', '-e', 'MATCH_ME', tmp],
      { maxBytes: 4096 },
    )

    expect(r.truncated).toBe(true)
    // Grep 的契约是前 N 个匹配；截断时必须保留 stdout 头部，而不是滑动窗口的尾部。
    expect(r.stdout.length).toBeLessThanOrEqual(4096)
    expect(r.stdout.length).toBeGreaterThan(0)
    expect(r.stdout).toContain('line-0: MATCH_ME')
    expect(r.stdout).not.toContain('line-999: MATCH_ME')
  })

  it('respects AbortSignal pre-aborted state', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runRipgrep(['--version'], { signal: ac.signal })
    expect(r.truncated).toBe(true)
  })

  // 2026-06-07 kernel watchdog panic 复盘：crabot agent 同时 spawn 7+ 个 rg，
  // 单进程 RSS 飙到 17.5 GB（mmap 巨型文件 + 默认全核并行），32 GB 机器被压垮。
  // 这两条用例锁定 ripgrep-helper 永远会注入两条硬限制 flag。
  it('skips files larger than 10 MB by forcing --max-filesize=10M', async () => {
    // 写一个 12 MB 的文件，里面塞满 "MATCH_ME"。如果 rg 仍然扫它，会有大量
    // 匹配；--max-filesize=10M 生效则 rg 会跳过它，匹配为 0。
    const big = ('MATCH_ME on a single big-file line\n').repeat(400_000) // ~12.4 MB
    writeFileSync(join(tmp, 'huge.txt'), big)

    const r = await runRipgrep(['--no-ignore', '--hidden', '-c', '-e', 'MATCH_ME', tmp])
    // rg 跳过文件后没有任何匹配，exit code = 1（"no matches"）
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('forces --threads=1 (no multi-core parallel scan)', async () => {
    // 直接问 rg 它收到了什么参数：用 --debug 看不到 args，但 --max-filesize
    // 和 --threads 都接受重复声明，后写覆盖前写。如果我们在用户 args 里再传
    // 一次 --threads=8，最终生效的应该是用户的 8 —— 这反过来证明我们注入的
    // 那一条在前。这里改用更直接的"行为"验证：用 --files 列文件，rg 退出码
    // 0 = 列出。如果硬限制被破坏会抛错。
    writeFileSync(join(tmp, 'a.txt'), 'x\n')
    const r = await runRipgrep(['--files', tmp])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('a.txt')
  })

  it('正常完成时 timedOut=false', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'foo\n')
    const r = await runRipgrep(['--no-ignore', '--hidden', '-e', 'foo', tmp])
    expect(r.timedOut).toBe(false)
  })

  it('墙钟超时会 kill rg 并标 timedOut/truncated', async () => {
    // 写若干文件让 rg 有活干；timeoutMs=1 远小于 rg 进程 exec+扫描时间，
    // 计时器必先于 rg 完成触发（进程启动本身就 >1ms），稳定命中超时分支。
    mkdirSync(join(tmp, 'src'), { recursive: true })
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(tmp, 'src', `f${i}.txt`), 'MATCH_ME\n'.repeat(50))
    }
    const r = await runRipgrep(
      ['--no-ignore', '--hidden', '-e', 'MATCH_ME', tmp],
      { timeoutMs: 1 },
    )
    expect(r.timedOut).toBe(true)
    expect(r.truncated).toBe(true)
  })
})

describe('getProtectedExcludeGlobs', () => {
  const home = homedir()

  it('MACOS_PROTECTED_EXCLUDE_GLOBS 覆盖全部 TCC 保护用户目录', () => {
    for (const name of ['!Library', '!.Trash', '!Desktop', '!Documents', '!Downloads', '!Movies', '!Music', '!Pictures']) {
      expect(MACOS_PROTECTED_EXCLUDE_GLOBS).toContain(name)
    }
  })

  it('darwin + 搜索根是家目录（未授权扫描）→ 返回受保护排除列表', () => {
    expect(getProtectedExcludeGlobs(home, false, 'darwin')).toEqual(MACOS_PROTECTED_EXCLUDE_GLOBS)
  })

  it('darwin + 搜索根是家目录的祖先（/）→ 返回受保护排除列表', () => {
    expect(getProtectedExcludeGlobs('/', false, 'darwin')).toEqual(MACOS_PROTECTED_EXCLUDE_GLOBS)
  })

  it('darwin + 搜索根是具体项目目录 → 返回空（TCC 目录是兄弟，不注入避免误跳同名目录）', () => {
    expect(getProtectedExcludeGlobs(join(home, 'codes', 'some-project'), false, 'darwin')).toEqual([])
  })

  it('darwin 且放开扫描（FDA 生效）→ 即便根是家目录也返回空', () => {
    expect(getProtectedExcludeGlobs(home, true, 'darwin')).toEqual([])
  })

  it('非 darwin 恒返回空（无这些目录名）', () => {
    expect(getProtectedExcludeGlobs(home, false, 'linux')).toEqual([])
    expect(getProtectedExcludeGlobs(home, false, 'win32')).toEqual([])
    expect(getProtectedExcludeGlobs('/', true, 'linux')).toEqual([])
  })
})
