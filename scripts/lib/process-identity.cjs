const path = require('node:path')
// Both standalone Node and Electron use this Node-API-only helper. It has no V8/libuv ABI dependency.
const native = require('../../crabot-native/build/Release/crabot-native.node')

function sameProcess(expected, actual) {
  return Boolean(expected && actual && expected.pid === actual.pid
    && expected.started === actual.started && expected.owner === actual.owner
    && path.normalize(expected.executable) === path.normalize(actual.executable))
}

module.exports = { ...native, sameProcess,
  inspectProcess: native.inspectProcess,
  listProcessIds: native.listProcessIds,
  tryFileLock: native.tryFileLock,
  releaseFileLock: native.releaseFileLock,
  inspectProcessArguments: native.inspectProcessArguments,
  ...(native.inspectPeer ? { inspectPeer: native.inspectPeer } : {}),
  ...(native.createPipeServer ? {
    createPipeServer: native.createPipeServer, acceptPipe: native.acceptPipe,
    closePipeServer: native.closePipeServer, connectPipe: native.connectPipe,
    inspectServerPeer: native.inspectServerPeer,
    readPipe: native.readPipe, writePipe: native.writePipe, closePipe: native.closePipe,
  } : {}),
}
