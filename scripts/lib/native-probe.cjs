// Run in a short-lived process so validation never pins a target Windows DLL.
const assert = require('node:assert/strict')
const path = require('node:path')
const native = require(path.join(process.argv[2], 'crabot-native.node'))
for (const name of ['inspectProcess', 'listProcessIds', 'listChildProcessIds', 'isProcessExited',
  'terminateProcessGeneration', 'tryFileLock', 'releaseFileLock', 'inspectProcessArguments', 'listListeningTcpPorts']) {
  assert.equal(typeof native[name], 'function', 'Native API missing: ' + name)
}
const self = native.inspectProcess(process.pid)
assert.equal(self.pid, process.pid)
assert.ok(self.owner && self.started && self.executable)
