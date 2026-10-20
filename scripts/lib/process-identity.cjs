const path = require('node:path')
const fs = require('node:fs')
// Both standalone Node and Electron use this Node-API-only helper. It has no V8/libuv ABI dependency.
const native = require('../../crabot-native/build/Release/crabot-native.node')

function sameProcess(expected, actual) {
  return Boolean(expected && actual && expected.pid === actual.pid
    && expected.started === actual.started && expected.owner === actual.owner
    && path.normalize(expected.executable) === path.normalize(actual.executable))
}

// One known target only. A successful submission is never an exit/whole-tree receipt.
function terminateKnownProcess(expected) {
  const pid = value => Number.isInteger(value) && value > 0 && value <= 2147483647
  const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length !== 5
    || !['pid', 'parent', 'owner', 'started', 'executable'].every(key => Object.hasOwn(expected, key))
    || !pid(expected.pid) || expected.parent !== 0 && !pid(expected.parent)
    || !text(expected.owner) || !text(expected.started) || !text(expected.executable)) {
    throw Object.assign(new Error('进程身份无法核验，未发送终止请求。'), { code: 'CRABOT_PROCESS_SIGNAL' })
  }
  return native.terminateProcessGeneration(expected.pid, expected.started, expected.owner)
}

module.exports = { ...native, sameProcess, terminateKnownProcess,
  renameDirectoryNoReplace: native.renameDirectoryNoReplace,
  inspectFileMetadata: native.inspectFileMetadata,
  inspectProcess: native.inspectProcess,
  inspectInstallFilesystem: native.inspectInstallFilesystem,
  listProcessIds: native.listProcessIds,
  listChildProcessIds: native.listChildProcessIds,
  isProcessExited: native.isProcessExited,
  tryFileLock: native.tryFileLock,
  releaseFileLock: native.releaseFileLock,
  inspectProcessArguments: native.inspectProcessArguments,
  listListeningTcpPorts: native.listListeningTcpPorts,
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
    isOwnedFile: native.isOwnedFile, createPrivateDirectory: native.createPrivateDirectory, isPrivateDirectory: native.isPrivateDirectory } : {}),
  ...(native.readUserPath ? { readUserPath: native.readUserPath, appendUserPathDirectory: native.appendUserPathDirectory,
    notifyUserPathChanged: native.notifyUserPathChanged } : {}),
}
