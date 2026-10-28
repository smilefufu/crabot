const fs = require('node:fs')
const path = require('node:path')
const installation = require('./desktop-installation.cjs')

// Host locations only. Neither a request nor a preview result supplies exclusions.
function workspaceRelocationTargetPolicy(dataDir) {
  const dataRoot = fs.realpathSync.native(dataDir), coreRoot = fs.realpathSync.native(path.resolve(__dirname, '../..'))
  const desktop = installation.locateDesktopCore(coreRoot)
  return { managedDefaultTarget: path.join(dataRoot, 'workspaces'), protectedRoots: [path.join(dataRoot, 'workspace-control')],
    protectedTargets: [dataRoot, coreRoot, ...(desktop ? ['app', 'releases', 'bin'].map(name => path.join(desktop.root, name)) : [])] }
}
module.exports = { workspaceRelocationTargetPolicy }
