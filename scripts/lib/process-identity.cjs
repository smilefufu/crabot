const path = require('node:path')
const fs = require('node:fs')
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
  isOwnedDirectory: native.isOwnedDirectory ?? (directory => {
    const stat = fs.lstatSync(directory)
    return stat.isDirectory() && !stat.isSymbolicLink() && String(stat.uid) === native.inspectProcess(process.pid).owner
  }),
  ...(native.inspectPeer ? { inspectPeer: native.inspectPeer } : {}),
  ...(native.createPipeServer ? {
    createPipeServer: native.createPipeServer, acceptPipe: native.acceptPipe,
    closePipeServer: native.closePipeServer, connectPipe: native.connectPipe,
    inspectServerPeer: native.inspectServerPeer,
    readPipe: native.readPipe, writePipe: native.writePipe, closePipe: native.closePipe,
  } : {}),
  ...(native.writePrivateFile ? { writePrivateFile: native.writePrivateFile, isPrivateFile: native.isPrivateFile,
    createPrivateDirectory: native.createPrivateDirectory, isPrivateDirectory: native.isPrivateDirectory } : {}),
}
