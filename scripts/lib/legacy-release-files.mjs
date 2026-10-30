// Raw fingerprints from verified release assets. Never normalize user code.
export function legacyReleaseFiles(catalog, version, platform = process.platform) {
  return { ...catalog.files, ...catalog.version_files[version], ...catalog.platform_files?.[platform] }
}

// These exact launchers are emitted by the published install.ps1 in both
// supported releases (system Node or private Node; downloaded LF/Git CRLF).
// They are installed bytes, not permission to normalize arbitrary old code.
const installedWindowsLaunchers = [
  '56b9ea72a1a063bfcae93ec5d94b3e5043d2c474448e94a350a7927caeae0273',
  'a0f2bac52f25cb40917de15ad06b06ab4590a6e7907ad969e45ef53d6cdbde2f',
  'a9b89c2a8f88140b1ae141f7fd44add80baa8225bd7b9181ea8eebd3952a8da3',
]
export function legacyReleaseEntryHashes(catalog, version, file, platform = process.platform) {
  const original = legacyReleaseFiles(catalog, version, platform)[file]
  return platform === 'win32' && file === 'crabot.cmd' && ['v2026.10.14.1', 'v2026.10.15.1'].includes(version)
    ? [original, ...installedWindowsLaunchers] : [original]
}
