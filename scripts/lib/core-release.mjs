// Immutable core inventory shared by desktop and CLI artifacts. This detects
// incomplete/mixed payloads; installer signatures authenticate their source.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const excluded = new Set(['core-files.json', 'core-release.json', 'desktop-host.json'])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw Object.assign(new Error('核心发行文件不完整或已改变，请修复安装。'), { code: 'CRABOT_CORE_INTEGRITY' }) }
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function inventory(root, expected) {
  const entries = []
  async function walk(directory) {
    const children = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file).split(path.sep).join('/')
      if (excluded.has(relative)) continue
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() || entry.isSymbolicLink()) entries.push({ file, relative })
      else fail()
    }
  }
  await walk(root)
  if (expected && (Object.keys(expected).length !== entries.length || entries.some(entry => !Object.hasOwn(expected, entry.relative)))) fail()
  const records = new Array(entries.length)
  async function readEntries(visit) {
    let cursor = 0, stopped = false
    async function reader() {
      while (!stopped && cursor < entries.length) {
        const index = cursor++
        await visit(entries[index], index)
      }
    }
    // Stop assigning work on failure and await every in-flight operation before cleanup.
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(8, entries.length) }, () => reader().catch(error => {
      stopped = true; throw error
    })))
    const failure = outcomes.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
  // Check the cheap complete tree before hashing large runtimes. No metadata cache
  // survives this call; every valid file still receives its full byte hash below.
  await readEntries(async ({ file, relative }, index) => {
    const stat = await fs.lstat(file)
    if (stat.isFile()) {
      records[index] = { type: 'file', size: stat.size, sha256: undefined,
        ...(process.platform === 'win32' ? {} : { mode: stat.mode & 0o777 }) }
      if (expected) {
        const wanted = expected[relative]
        if (wanted?.type !== 'file' || wanted.size !== stat.size || !/^[a-f0-9]{64}$/.test(wanted.sha256)
          || process.platform !== 'win32' && wanted.mode !== records[index].mode) fail()
      }
    } else if (stat.isSymbolicLink()) {
      const target = await fs.readlink(file)
      if (path.isAbsolute(target) || !inside(root, await fs.realpath(file))) fail()
      records[index] = { type: 'link', target }
      if (expected && JSON.stringify(expected[relative]) !== JSON.stringify(records[index])) fail()
    } else fail()
  })
  await readEntries(async ({ file, relative }, index) => {
    if (records[index].type === 'file') records[index].sha256 = await hashFile(file)
    if (expected && JSON.stringify(expected[relative]) !== JSON.stringify(records[index])) fail()
  })
  const files = Object.create(null)
  for (let index = 0; index < entries.length; index++) files[entries[index].relative] = records[index]
  return { schema_version: 1, files }
}

export async function writeCoreRelease(directory, release) {
  const root = await fs.realpath(directory), index = await inventory(root)
  const text = JSON.stringify(index) + '\n'
  await fs.writeFile(path.join(root, 'core-files.json'), text, { flag: 'wx' })
  await fs.writeFile(path.join(root, 'core-release.json'), JSON.stringify({ ...release, inventory_sha256: digest(text) }, null, 2) + '\n', { flag: 'wx' })
  return { files: Object.keys(index.files).length, bytes: Object.values(index.files).reduce((total, file) => total + (file.size ?? 0), 0) }
}

export async function verifyCoreRelease(directory, { version, platform = process.platform, arch = process.arch } = {}) {
  try {
    const root = await fs.realpath(directory)
    for (const name of ['core-release.json', 'core-files.json']) {
      const stat = await fs.lstat(path.join(root, name))
      if (!stat.isFile() || stat.size > (name === 'core-release.json' ? 65_536 : 64 * 1024 * 1024)) fail()
    }
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'core-release.json'), 'utf8'))
    if (metadata.schema_version !== 1 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(metadata.version)
      || (version && metadata.version !== version) || metadata.platform !== platform || metadata.arch !== arch
      || !/^[a-f0-9]{40}$/.test(metadata.commit) || typeof metadata.source_dirty !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(metadata.inventory_sha256)) fail()
    const text = await fs.readFile(path.join(root, 'core-files.json'), 'utf8')
    if (digest(text) !== metadata.inventory_sha256) fail()
    const expected = JSON.parse(text)
    if (expected.schema_version !== 1 || !expected.files || typeof expected.files !== 'object' || Array.isArray(expected.files)) fail()
    const actual = await inventory(root, expected.files)
    if (JSON.stringify(expected) !== JSON.stringify(actual)) fail()
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    const runtime = JSON.parse(await fs.readFile(path.join(root, 'product-runtime.json'), 'utf8'))
    if (packageJson.version !== metadata.version || runtime.version !== metadata.version) fail()
    return metadata
  } catch { fail() }
}
