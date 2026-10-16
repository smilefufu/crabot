import { spawn } from 'node:child_process'
import { dirname, extname, basename } from 'node:path'

const RUNNERS = {
  '.py': ['uv', ['run', 'python']],
  '.mjs': ['node', []],
  '.js': ['node', []],
  '.ts': ['npx', ['tsx']],
}

// Windows shell 调用见 source.mjs 的注释。这里 args 含路径（scriptPath/dataDir），
// 可能带空格，必须用双引号包裹。
const quoteWin = (s) => (/\s/.test(s) ? `"${s}"` : s)

export function runScript(scriptPath, dataDir) {
  const ext = extname(scriptPath)
  const runner = RUNNERS[ext]
  if (!runner) {
    return Promise.reject(new Error(`unsupported script extension: ${ext}`))
  }
  const [cmd, baseArgs] = runner

  // 以模块目录作为 cwd（脚本路径形如 <moduleDir>/upgrade/<name>.<ext>），
  // 这样 `uv run` 能定位到模块的 pyproject.toml；node/tsx 也能解析模块自身依赖。
  const cwd = dirname(dirname(scriptPath))
  const memoryPython = ext === '.py' && basename(cwd) === 'crabot-memory'
  const dev = process.env.CRABOT_DEV === 'true'
  const args = [...(memoryPython ? ['run', '--frozen', ...(dev ? [] : ['--no-dev']), 'python'] : baseArgs), scriptPath, `--data-dir=${dataDir}`]
  const env = ext === '.py' ? { ...process.env, PYTHONIOENCODING: 'utf-8' } : process.env

  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const proc = isWin
      ? spawn(`${cmd} ${args.map(quoteWin).join(' ')}`, [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      : spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
