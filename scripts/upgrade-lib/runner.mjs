import { spawn } from 'node:child_process'
import { dirname, extname } from 'node:path'

const RUNNERS = {
  '.py': ['uv', ['run', 'python']],
  '.mjs': ['node', []],
  '.js': ['node', []],
  '.ts': ['npx', ['tsx']],
}

export function runScript(scriptPath, dataDir) {
  const ext = extname(scriptPath)
  const runner = RUNNERS[ext]
  if (!runner) {
    return Promise.reject(new Error(`unsupported script extension: ${ext}`))
  }
  const [cmd, baseArgs] = runner
  const args = [...baseArgs, scriptPath, `--data-dir=${dataDir}`]

  // 以模块目录作为 cwd（脚本路径形如 <moduleDir>/upgrade/<name>.<ext>），
  // 这样 `uv run` 能定位到模块的 pyproject.toml；node/tsx 也能解析模块自身依赖。
  const cwd = dirname(dirname(scriptPath))

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString()
      stdout += s
      process.stdout.write(s)
    })
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString()
      stderr += s
      process.stderr.write(s)
    })
    proc.on('error', reject)
    proc.on('exit', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
  })
}
