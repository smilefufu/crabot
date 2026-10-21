// Neutral fixed-plan directory effects only. The original Root coordinator owns durable preparation and authorization.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'

const failure = () => Object.assign(new Error('目标工作目录发布无法核实，已保留文件、暂存及原空目录；维护仍在。'), { code: 'WORKSPACE_ROOT_PUBLISH_UNVERIFIED' })
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.normalize(value) === value && path.dirname(value) !== value
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const within = (root, item) => { const relative = path.relative(root, item); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const validIdentity = value => fields(value, ['path', 'dev', 'ino', 'native_id']) && absolute(value.path)
  && typeof value.dev === 'string' && /^[0-9]+$/.test(value.dev) && typeof value.ino === 'string' && /^[1-9][0-9]*$/.test(value.ino)
  && (process.platform === 'win32' ? typeof value.native_id === 'string' && /^[0-9]+:[a-f0-9]{32}$/i.test(value.native_id) : value.native_id === null)
function observe(file) {
  let stat
  try { stat = fs.lstatSync(file, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino || fs.realpathSync(file) !== file) throw failure()
  return { path: file, dev: stat.dev.toString(), ino: stat.ino.toString(), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(file) : null }
}
const matches = (expected, actual, at = expected.path) => Boolean(actual && actual.path === at && actual.dev === expected.dev && actual.ino === expected.ino && actual.native_id === expected.native_id)
function sync(directory) {
  if (process.platform === 'win32') return // The existing Native move uses MOVEFILE_WRITE_THROUGH.
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function validatePublicationPlan(plan, prefix) {
  if (!fields(plan, ['intent_id', 'container', 'tree', 'target', 'target_parent', 'empty_target']) || typeof plan.intent_id !== 'string' || !uuid.test(plan.intent_id)
    || !validIdentity(plan.container) || !validIdentity(plan.tree) || !validIdentity(plan.target_parent) || !absolute(plan.target)
    || plan.empty_target !== null && (!validIdentity(plan.empty_target) || plan.empty_target.path !== plan.target)
    || path.basename(plan.container.path) !== prefix + plan.intent_id || plan.tree.path !== path.join(plan.container.path, 'tree')
    || path.dirname(plan.target) !== plan.target_parent.path || within(plan.container.path, plan.target) || within(plan.target, plan.container.path)
    || plan.tree.dev !== plan.container.dev || plan.tree.dev !== plan.target_parent.dev) throw failure()
}

export function validateWorkspaceRootPublicationPlan(plan) {
  validatePublicationPlan(plan, '.crabot-workspace-')
}
export function validateWorkspaceParentsPublicationPlan(plan) {
  validatePublicationPlan(plan, '.crabot-workspace-parents-')
  if (plan.empty_target !== null) throw failure()
}

// Directory effects only; each owner retains its fixed plan, content checks and original job authority.
async function publishDirectory(plan, verify, signal) {
  if (typeof verify !== 'function') throw failure()
  const hold = path.join(plan.target_parent.path, '.crabot-workspace-empty-' + plan.intent_id), pins = []
  const check = () => {
    if (signal?.aborted || !matches(plan.container, observe(plan.container.path)) || !matches(plan.target_parent, observe(plan.target_parent.path))
      || fs.readdirSync(plan.container.path).some(name => name !== 'tree')) throw failure()
  }
  const emptyHold = () => {
    const actual = observe(hold)
    if (plan.empty_target === null) { if (actual) throw failure(); return }
    if (!matches(plan.empty_target, actual, hold) || fs.readdirSync(hold).length) throw failure()
  }
  try {
    await verify(); check()
    if (process.platform === 'win32') for (const directory of [plan.container.path, plan.target_parent.path]) pins.push(native.pinDirectory(directory))
    check()
    const source = observe(plan.tree.path)
    let target = observe(plan.target)
    if (!source && matches(plan.tree, target, plan.target)) {
      emptyHold(); sync(plan.container.path); sync(plan.target_parent.path)
      await verify(); check(); emptyHold()
      if (observe(plan.tree.path) || !matches(plan.tree, observe(plan.target), plan.target)) throw failure()
      return { dispatch: 'observe', target }
    }
    if (!matches(plan.tree, source)) throw failure()
    if (target) {
      if (!plan.empty_target || !matches(plan.empty_target, target) || fs.readdirSync(plan.target).length || observe(hold)) throw failure()
      await verify(); check()
      if (!matches(plan.tree, observe(plan.tree.path)) || !matches(plan.empty_target, observe(plan.target)) || fs.readdirSync(plan.target).length || observe(hold)) throw failure()
      native.renameDirectoryNoReplace(plan.target, hold); sync(plan.target_parent.path)
    }
    emptyHold()
    await verify(); check(); emptyHold()
    if (!matches(plan.tree, observe(plan.tree.path)) || observe(plan.target)) throw failure()
    native.renameDirectoryNoReplace(plan.tree.path, plan.target)
    sync(plan.container.path); sync(plan.target_parent.path)
    await verify(); check(); emptyHold()
    target = observe(plan.target)
    if (observe(plan.tree.path) || !matches(plan.tree, target, plan.target)) throw failure()
    return { dispatch: 'dispatch', target }
  } finally { for (const pin of pins.reverse()) native.releaseDirectoryPin(pin) }
}


export async function publishWorkspaceRoot({ plan: input, verify, signal }) {
  const plan = structuredClone(input)
  validateWorkspaceRootPublicationPlan(plan)
  return publishDirectory(plan, verify, signal)
}
export async function publishWorkspaceParents({ plan: input, verify, signal }) {
  const plan = structuredClone(input)
  validateWorkspaceParentsPublicationPlan(plan)
  return publishDirectory(plan, verify, signal)
}
