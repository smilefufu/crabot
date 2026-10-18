// Raw fingerprints from verified release assets. Never normalize user code.
export function legacyReleaseFiles(catalog, version, platform = process.platform) {
  return { ...catalog.files, ...catalog.version_files[version], ...catalog.platform_files?.[platform] }
}
