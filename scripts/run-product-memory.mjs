#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import product from './lib/product-runtime.cjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = product.loadProductRuntime(root, { required: true })
const check = process.argv.includes('--check')
const script = 'import sys, runpy; sys.path[:0] = sys.argv[1:3]; '
  + (check ? 'import src.main' : 'runpy.run_module("src.main", run_name="__main__")')
const child = spawn(runtime.executables.python, ['-I', '-X', 'utf8', '-B', '-c', script, runtime.memoryPackages, resolve(root, 'crabot-memory')], {
  cwd: resolve(root, 'crabot-memory'), stdio: 'inherit',
  env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', error => { console.error('[crabot] Memory runtime failed: ' + error.message); process.exitCode = 1 })
child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
