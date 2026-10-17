import { spawn } from 'node:child_process'
import { dirname, extname, basename, resolve } from 'node:path'
import product from '../lib/product-runtime.cjs'

const RUNNERS = {
  '.py': ['uv', ['run', 'python']],
  '.mjs': ['node', []],
  '.js': ['node', []],
  '.ts': ['npx', ['tsx']],
}

// Windows shell 调用见 source.mjs 的注释。这里 args 含路径（scriptPath/dataDir），
// 可能带空格，必须用双引号包裹。
const quoteWin = (s) => (/\s/.test(s) ? `"${s}"` : s)

export function runScript(scriptPath, dataDir, { root, env: sourceEnv = process.env } = {}) {
  const ext = extname(scriptPath)
  const runner = RUNNERS[ext]
  if (!runner) {
    return Promise.reject(new Error(`unsupported script extension: ${ext}`))
  }
  let [cmd, baseArgs] = runner

  // 以模块目录作为 cwd（脚本路径形如 <moduleDir>/upgrade/<name>.<ext>），
  // 这样 `uv run` 能定位到模块的 pyproject.toml；node/tsx 也能解析模块自身依赖。
  const cwd = dirname(dirname(scriptPath))
  const runtime = product.loadProductRuntime(root ?? dirname(cwd), { required: sourceEnv.CRABOT_PRODUCT_REQUIRED === '1' })
  const memoryPython = ext === '.py' && basename(cwd) === 'crabot-memory'
  const dev = sourceEnv.CRABOT_DEV === 'true'
  const args = [...(memoryPython ? ['run', '--frozen', ...(dev ? [] : ['--no-dev']), 'python'] : baseArgs), scriptPath, `--data-dir=${dataDir}`]
  let env = ext === '.py' ? { ...sourceEnv, PYTHONIOENCODING: 'utf-8' } : sourceEnv
  if (runtime) {
    env = product.productEnvironment(runtime, resolve(dataDir, '..'), sourceEnv)
    if (ext === '.ts') return Promise.reject(new Error('Sealed migrations must be precompiled; startup never installs tsx'))
    if (ext === '.py') {
      cmd = runtime.executables.python
      delete env.PYTHONPATH; delete env.PYTHONHOME
      env.PYTHONIOENCODING = 'utf-8'; env.PYTHONNOUSERSITE = '1'; env.PYTHONDONTWRITEBYTECODE = '1'
      args.splice(0, args.length, '-I', '-B')
      if (memoryPython) {
        // The migration consumes Memory's immutable product packages; it must not
        // start the Memory service or inherit the writable Agent/MCP environment.
        const launch = 'import runpy,sys; packages,module,script,*args=sys.argv[1:];sys.path[:0]=[packages,module];sys.argv=[script,*args];runpy.run_path(script,run_name="__main__")'
        args.push('-c', launch, runtime.memoryPackages, cwd)
      }
      args.push(scriptPath, `--data-dir=${dataDir}`)
    } else cmd = runtime.executables.node
  }

  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const proc = isWin && !runtime
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
