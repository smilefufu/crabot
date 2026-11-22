// Source build receipts only. No addon import, network access or compilation here.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const failure = message => Object.assign(new Error(`原生组件：${message}；请先运行 crabot upgrade 完成准备。`), { code: 'CRABOT_NATIVE_PREPARATION' })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const standardDirectory = root => path.join(root, 'crabot-native/build/Release')
const nativeFiles = () => ['crabot-native.node', process.platform === 'win32' ? 'crabot.exe' : 'crabot',
  'crabot-copy-cleanup' + (process.platform === 'win32' ? '.exe' : ''),
  ...(process.platform === 'win32' ? ['crabot-install-directory.exe', 'crabot-hidden-console.exe'] : [])]
const isSourceTree = root => fs.existsSync(path.join(root, '.git'))
  && !['core-release.json', 'core-files.json', 'product-runtime.json', '.product-runtime', 'desktop-host.json'].some(name => fs.existsSync(path.join(root, name)))

function trustedPaths(root, files) {
  const checked = new Set([root])
  for (const file of files) {
    const relative = path.relative(root, file)
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw failure('构建路径超出源码根')
    let current = root
    for (const part of relative.split(path.sep).filter(Boolean)) { current = path.join(current, part); checked.add(current) }
  }
  for (const file of checked) {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw failure('构建路径归属或写权限无法核验')
    if (process.platform !== 'win32') {
      const foreignOwner = stat.uid !== process.getuid() && stat.uid !== 0
      if (foreignOwner || stat.mode & 0o022) throw failure('构建路径归属或写权限无法核验')
    }
  }
  if (process.platform === 'win32') {
    // Node's Windows stat does not expose ACLs. Observe them before loading any addon.
    // Worker process.env keys are case-sensitive, unlike the main Windows thread.
    const systemRoot = process.env[Object.keys(process.env).find(key => key.toUpperCase() === 'SYSTEMROOT')]
    if (!systemRoot) throw failure('无法定位 Windows 系统权限检查工具')
    const script = '$ErrorActionPreference="Stop";$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544");'
      + 'foreach($p in (ConvertFrom-Json $env:CRABOT_NATIVE_CHECK_PATHS)){'
      + '$a=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)};'
      + 'if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw "Foreign native owner"};'
      + 'foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){'
      + 'if($r.AccessControlType -eq "Allow" -and ($r.FileSystemRights.value__ -band 0xD0156) -and $r.IdentityReference.Value -notin $allowed){throw "Writable native path"}}}'
    execFileSync(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000, stdio: 'pipe',
        env: { ...process.env, CRABOT_NATIVE_CHECK_PATHS: JSON.stringify([...checked]) } })
  }
}

function nativeSignature(root, nodeVersion = process.version) {
  const files = ['scripts/build-native.mjs', 'scripts/lib/native-build.cjs', 'scripts/lib/native-probe.cjs']
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile()) files.push(name)
      else throw failure('原生构建输入不是普通文件')
    }
  }
  visit('crabot-native/src')
  trustedPaths(root, files.map(file => path.join(root, file)))
  const hash = createHash('sha256').update(JSON.stringify([process.platform, process.arch, nodeVersion, process.env.CXX || 'c++']))
  for (const file of files) hash.update(file.split(path.sep).join('/')).update(fs.readFileSync(path.join(root, file)))
  return hash.digest('hex')
}

function nativeReady(root, directory, signature) {
  try {
    const files = nativeFiles(), receipt = path.join(directory, 'native-build.json')
    trustedPaths(root, [receipt, ...files.map(name => path.join(directory, name))])
    const record = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    if (!record || !/^v\d+\.\d+\.\d+$/.test(record.node)) return false
    // The dev GUI consumes the same Node-API-only build, despite Electron's embedded Node version.
    signature ??= nativeSignature(root, process.versions.electron ? record.node : process.version)
    return record.signature === signature && record.files && Object.keys(record.files).sort().join() === [...files].sort().join()
      && files.every(name => record.files[name] === sha(fs.readFileSync(path.join(directory, name))))
  } catch (error) {
    if (['ENOENT', 'EACCES', 'CRABOT_NATIVE_PREPARATION'].includes(error.code) || error instanceof SyntaxError) return false
    throw error
  }
}

function writeNativeReceipt(root, directory, signature) {
  if (nativeSignature(root) !== signature) throw failure('构建期间输入发生变化')
  const files = Object.fromEntries(nativeFiles().map(name => [name, sha(fs.readFileSync(path.join(directory, name)))]))
  fs.writeFileSync(path.join(directory, 'native-build.json'), JSON.stringify({ signature, node: process.version, files }) + '\n', { mode: process.getuid?.() === 0 ? 0o644 : 0o600 })
}

const bootstrapDirectory = (root, signature) => path.join(root, '.desktop-build/upgrade-native', signature)
function resolveNative(root) {
  if (!isSourceTree(root)) return path.join(standardDirectory(root), 'crabot-native.node')
  const signature = process.versions.electron ? undefined : nativeSignature(root)
  const directories = signature ? [bootstrapDirectory(root, signature), standardDirectory(root)] : [standardDirectory(root)]
  for (const directory of directories) {
    if (nativeReady(root, directory, signature)) return path.join(directory, 'crabot-native.node')
  }
  throw failure('缺少与当前源码匹配的原生组件')
}

module.exports = { failure, isSourceTree, nativeFiles, trustedPaths, nativeSignature, nativeReady,
  standardDirectory, bootstrapDirectory, writeNativeReceipt, resolveNative }
