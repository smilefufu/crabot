import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopReleaseManifestSchema, DesktopReleaseSignaturesSchema, serializeDesktopReleaseManifest, serializeDesktopReleaseSignatures, desktopReleaseMetadataNames } from '../dist/contracts/desktop-release.js'
const manifest = { schema_version: 1, app_id: 'com.crabot.desktop', platform: 'linux', arch: 'x64',
  selection: { schema_version: 1, version: '1.2.3', gui_id: '00112233-4455-6677-8899-aabbccddeeff', core_id: 'a'.repeat(64) },
  artifact: { file: 'Crabot-1.2.3-linux-x64.tar.gz', size: 123, sha256: 'b'.repeat(64) } }
test('release manifest has one strict nested format and deterministic canonical order', () => {
  assert.equal(serializeDesktopReleaseManifest({ artifact: manifest.artifact, ...manifest }), JSON.stringify(manifest) + '\n')
  for (const value of [{ ...manifest, unknown: true }, { ...manifest, app_id: 'another.app' }, { ...manifest, platform: 'win32', arch: 'arm64' },
    { ...manifest, selection: { ...manifest.selection, unknown: true } }, { ...manifest, artifact: { ...manifest.artifact, url: 'https://example.test' } }]) {
    assert.equal(DesktopReleaseManifestSchema.safeParse(value).success, false)
  }
  for (const file of ['../a.zip', '/a.zip', 'a%2f.zip', 'https://example.test/a.zip', 'a.exe', 'a.zip?key=secret', 'a\\b.zip']) {
    assert.equal(DesktopReleaseManifestSchema.safeParse({ ...manifest, artifact: { ...manifest.artifact, file } }).success, false)
  }
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(DesktopReleaseManifestSchema.safeParse({ ...manifest, artifact: { ...manifest.artifact, size } }).success, false)
})
test('signature envelope rejects duplicates, unknown fields and noncanonical 64-byte base64url', () => {
  const item = { key_id: 'c'.repeat(64), signature: Buffer.alloc(64, 7).toString('base64url') }, envelope = { schema_version: 1, signatures: [item] }
  assert.equal(serializeDesktopReleaseSignatures(envelope), JSON.stringify(envelope) + '\n')
  for (const signatures of [[], [item, item], Array.from({ length: 5 }, (_, i) => ({ ...item, key_id: String(i).repeat(64) })),
    [{ ...item, public_key: 'untrusted' }], [{ ...item, signature: item.signature + '=' }], [{ ...item, signature: 'A'.repeat(85) + 'B' }]]) {
    assert.equal(DesktopReleaseSignaturesSchema.safeParse({ ...envelope, signatures }).success, false)
  }
})
test('metadata names are derived solely from a supported platform and architecture', () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']]) {
    assert.deepEqual(desktopReleaseMetadataNames(platform, arch), { manifest: `crabot-desktop-${platform}-${arch}.manifest.json`, signatures: `crabot-desktop-${platform}-${arch}.signatures.json` })
  }
  assert.throws(() => desktopReleaseMetadataNames('linux', 'arm64'))
  assert.throws(() => desktopReleaseMetadataNames('../private', 'x64'))
})
