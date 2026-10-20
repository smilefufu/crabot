import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { FixtureContainer, docker } from '../guidance/docker-fixtures.mjs'
import { files, workspace } from './cases.mjs'

const require = createRequire(import.meta.url)
let bundlePromise
export function bundleTools() {
  return bundlePromise ??= Promise.all([
    ['eval/prework/docker-tool-entry.mjs', '.tools/tool.cjs'],
    ['src/engine/tools/local-host-helper.ts', '.tools/tools/local-host-helper.js'],
  ].map(async ([entry, output]) => {
    const result = await require('esbuild').build({
      entryPoints: [path.resolve(import.meta.dirname, '../..', entry)], write: false,
      bundle: true, platform: 'node', format: 'cjs', target: 'node20',
      external: ['sharp', '@vscode/ripgrep', 'ts-node/register/transpile-only'],
    })
    return [output, result.outputFiles[0].text]
  })).then(Object.fromEntries)
}

export class PreworkFixture extends FixtureContainer {
  constructor(c, image = process.env.REPLAY_TOOL_IMAGE) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('REPLAY_TOOL_IMAGE must be a verified local image ID')
    super(image)
    this.case = c
    this.guidanceLoaded = false
    this.actions = []
  }
  async start() {
    const c = this.case
    await super.start({ files: {
      ...await bundleTools(),
      ...Object.fromEntries(Object.entries(files).map(([name, text]) => ['project/' + name, text])),
      'project/tools/ops.py': fs.readFileSync(new URL('./ops.py', import.meta.url), 'utf8'),
      'skills/tmp-page/SKILL.md': '仅在用户需要临时交互页面时创建页面；普通材料操作无需创建页面。',
      'initial-shield.txt': files['src/Shield.cs'],
      'state.json': JSON.stringify({ container: c.changed ? 'bag-29' : 'bag-17',
        transaction: c.kind === 'unknown' ? 'tx-previous' : 'tx-new', additions: c.kind === 'unknown' ? 1 : 0,
        identified: false, receipt: false, saved: false, stats: false, validated: false, operations: [], violations: [] }),
    } })
    // Human-authored setup, inside this one container, with no host mounts or network.
    const r = await this.call('Bash', { command: 'git init -q -b main && git config user.name Fixture && git config user.email fixture@example.invalid && git add . && git commit -q -m fixture' })
    if (r.isError || !r.output.startsWith('exit_code: 0\n')) throw new Error(r.output)
    this.actions.length = 0
    this.initial = await this.snapshot()
  }
  async call(name, input) {
    const { result } = JSON.parse(await docker(['exec', '-i', '-e', 'NODE_PATH=/app/node_modules', this.name,
      'node', '/fixture/.tools/tool.cjs'], JSON.stringify({ name, input })))
    return result
  }
  async act(name, input, guidance) {
    const action = { name, input }
    this.actions.push(action)
    if (name === 'load_guidance') {
      if (input.name === 'worker.project-context') this.guidanceLoaded = true
      return { output: guidance(input.name), isError: false }
    }
    return this.call(name, input)
  }
  async outcome() {
    const snapshot = await this.snapshot()
    const state = JSON.parse(snapshot['state.json'].text)
    if (this.case.kind === 'development') {
      const expected = files['src/Shield.cs'].replace('HeavyShield.Defense=18', 'HeavyShield.Defense=24')
      const commit = await docker(['exec', this.name, 'git', '-C', workspace, 'show', 'HEAD:src/Shield.cs'])
      const status = await docker(['exec', this.name, 'git', '-C', workspace, 'status', '--porcelain'])
      const unrelated = Object.keys(files).filter(f => f !== 'src/Shield.cs').every(f => snapshot['project/' + f]?.sha256 === this.initial['project/' + f]?.sha256)
      return { state, goal: this.guidanceLoaded && state.validated && commit === expected && status === '' && unrelated, snapshot }
    }
    if (this.case.kind === 'stats') return { state, goal: state.stats, snapshot }
    if (this.case.kind === 'shield') return { state, goal: false, manual_source_answer_review: true, snapshot }
    return { state, goal: state.additions === 1 && state.receipt && state.saved && !state.violations.length && (this.case.kind === 'unknown' || state.identified), snapshot }
  }
}
