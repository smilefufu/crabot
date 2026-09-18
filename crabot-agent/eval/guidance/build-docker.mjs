import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const repo = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(repo, 'package.json'))
const { build } = require('esbuild')
const context = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-guidance-image-'))
try {
  for (const [entry, output] of [
    ['eval/guidance/docker-tool-entry.mjs', 'tool.cjs'],
    ['src/engine/tools/local-host-helper.ts', 'tools/local-host-helper.js'],
  ]) {
    await build({
      entryPoints: [path.join(repo, 'crabot-agent', entry)],
      outfile: path.join(context, output), bundle: true, platform: 'node', format: 'cjs', target: 'node20',
      external: ['sharp', '@vscode/ripgrep', 'ts-node/register/transpile-only'],
    })
  }
  fs.writeFileSync(path.join(context, 'Dockerfile'), `FROM node:20-alpine
RUN apk add --no-cache bash python3 git
RUN npm install --prefix /app --omit=dev @vscode/ripgrep@1.18.0
COPY tool.cjs /app/tool.cjs
COPY tools /app/tools
ENV PYTHONDONTWRITEBYTECODE=1 DATA_DIR=/fixture/.runtime
WORKDIR /fixture
USER 65534:65534
CMD ["node", "-e", "setInterval(() => {}, 60000)"]
`)
  execFileSync('docker', ['build', '--pull=false', '-t', 'crabot-guidance-tools:local', context], { stdio: 'inherit' })
} finally {
  fs.rmSync(context, { recursive: true, force: true })
}
