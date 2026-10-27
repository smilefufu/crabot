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

// Native Win32 private ACL APIs need extended paths; retain the exact text/body arguments.
const filesystemPath = method => process.platform === 'win32'
  ? (file, ...args) => method(path.toNamespacedPath(file), ...args) : method

module.exports = { ...native, sameProcess, terminateKnownProcess,
  renameDirectoryNoReplace: native.renameDirectoryNoReplace,
  renameFileNoReplace: native.renameFileNoReplace,
  inspectFileMetadata: native.inspectFileMetadata,
  inspectDirectoryWriteAccess: native.inspectDirectoryWriteAccess,
  inspectWorkspaceOwnerAccess: native.inspectWorkspaceOwnerAccess,
  compareWorkspaceOwnerInheritance: native.compareWorkspaceOwnerInheritance,
  createPrivateStagingDirectory: native.createPrivateStagingDirectory,
  enterDirectoryFd: native.enterDirectoryFd,
  copyDirectoryTimesFd: native.copyDirectoryTimesFd,
  inspectDirectoryFileId: native.inspectDirectoryFileId,
  inspectCurrentPrimaryGroup: native.inspectCurrentPrimaryGroup,
  createWorkspaceCopyJob: native.createWorkspaceCopyJob,
  inspectWorkspaceCopyJob: native.inspectWorkspaceCopyJob,
  resumeWorkspaceCopyJob: native.resumeWorkspaceCopyJob,
  closeWorkspaceCopyJob: native.closeWorkspaceCopyJob,
  pinDirectory: native.pinDirectory,
  releaseDirectoryPin: native.releaseDirectoryPin,
  copyPinnedDirectoryMetadata: native.copyPinnedDirectoryMetadata,
  syncPinnedWorkspaceTree: native.syncPinnedWorkspaceTree,
  copyPinnedWorkspaceMetadata: native.copyPinnedWorkspaceMetadata,
  inspectProcess: native.inspectProcess,
  inspectInstallFilesystem: native.inspectInstallFilesystem,
  inspectProgramReferences: native.inspectProgramReferences,
  listProcessIds: native.listProcessIds,
  listChildProcessIds: native.listChildProcessIds,
  ...(native.captureProcessTreeGeneration ? { captureProcessTreeGeneration: native.captureProcessTreeGeneration } : {}),
  isProcessExited: native.isProcessExited,
  tryFileLock: native.tryFileLock,
  releaseFileLock: native.releaseFileLock,
  inspectProcessArguments: native.inspectProcessArguments,
  listListeningTcpPorts: native.listListeningTcpPorts,
  isOwnedDirectory: native.isOwnedDirectory ? filesystemPath(native.isOwnedDirectory) : (directory => {
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
  ...(native.writePrivateFile ? { writePrivateFile: filesystemPath(native.writePrivateFile), isPrivateFile: filesystemPath(native.isPrivateFile),
    isOwnedFile: filesystemPath(native.isOwnedFile), createPrivateDirectory: filesystemPath(native.createPrivateDirectory), isPrivateDirectory: filesystemPath(native.isPrivateDirectory) } : {}),
  ...(native.isExistingDataDirectory ? { isExistingDataDirectory: filesystemPath(native.isExistingDataDirectory) } : {}),
  ...(native.isOwnerOnlyFile && native.isOwnerOnlyDirectory ? { isOwnerOnlyFile: filesystemPath(native.isOwnerOnlyFile),
    isOwnerOnlyDirectory: filesystemPath(native.isOwnerOnlyDirectory) } : {}),
  ...(native.inspectDesktopLoginStartup ? { inspectDesktopLoginStartup: native.inspectDesktopLoginStartup } : {}),
  ...(native.retargetDesktopLoginStartup ? { retargetDesktopLoginStartup: native.retargetDesktopLoginStartup } : {}),
  ...(native.removeDesktopLoginStartup ? { removeDesktopLoginStartup: native.removeDesktopLoginStartup } : {}),
  ...(native.readUserPath ? { readUserPath: native.readUserPath, appendUserPathDirectory: native.appendUserPathDirectory,
    notifyUserPathChanged: native.notifyUserPathChanged } : {}),
}
