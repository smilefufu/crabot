// Join a fresh, exact, trusted tmux carrier observation to kernel process facts.
// The tmux server is an identity anchor, never an execution stop target.
const native = require('./process-identity.cjs')
const { captureOwnedProcessTree } = require('./owned-process-tree.cjs')
const fail = () => { throw Object.assign(new Error('原生会话与实际执行进程无法共同核验，已保留维护保护。'), { code: 'CRABOT_PROCESS_SCOPE' }) }
const pid = value => Number.isInteger(value) && value > 0 && value <= 2147483647
const keys = ['session_name', 'session_id', 'pane_id', 'pane_pid', 'dead', 'server_pid']
const carrierValid = value => value && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
  && ['session_name', 'session_id', 'pane_id'].every(key => typeof value[key] === 'string')
  && /^crabot-w-[A-Za-z0-9_-]+$/.test(value.session_name) && /^\$[0-9]+$/.test(value.session_id) && /^%[0-9]+$/.test(value.pane_id)
  && pid(value.pane_pid) && pid(value.server_pid) && value.dead === false
const identityValid = value => value && pid(value.pid) && typeof value.owner === 'string' && value.owner
  && typeof value.started === 'string' && value.started && typeof value.executable === 'string' && value.executable
async function captureTmuxProcessTree(readCarrier, api = native) {
  try {
    const observed = await readCarrier()
    if (!carrierValid(observed)) fail()
    const first = Object.freeze({ ...observed })
    const self = api.inspectProcess(process.pid), server = api.inspectProcess(first.server_pid), root = api.inspectProcess(first.pane_pid)
    if (!identityValid(self) || !identityValid(server) || server.pid !== first.server_pid || server.owner !== self.owner
      || !identityValid(root) || root.pid !== first.pane_pid || root.parent !== server.pid || root.owner !== self.owner) fail()
    const processes = captureOwnedProcessTree([root], api)
    const second = await readCarrier()
    if (!carrierValid(second) || keys.some(key => first[key] !== second[key])) fail()
    const currentServer = api.inspectProcess(server.pid), currentRoot = api.inspectProcess(root.pid)
    if (!identityValid(currentServer) || !native.sameProcess(server, currentServer) || !identityValid(currentRoot)
      || currentRoot.pid !== root.pid || currentRoot.started !== root.started || currentRoot.owner !== root.owner || currentRoot.parent !== server.pid) fail()
    return processes
  } catch { fail() }
}
module.exports = { captureTmuxProcessTree }
