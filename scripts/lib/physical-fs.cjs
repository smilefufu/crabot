// Integrity/copy operations must see archive bytes, not Electron's ASAR virtual
// directories. This does not change the process-wide ASAR module loader.
module.exports = require(process.versions.electron ? 'original-fs' : 'node:fs')
