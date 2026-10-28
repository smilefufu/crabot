// Update-specific fixture entry; the common producer only seals a GUI/Core pair.
import { buildDesktopComponentSource } from './build-desktop-component-source.mjs'
export function buildPairedUpdateSource(options) {
  return buildDesktopComponentSource({ ...options, entryFixture: 'paired-update-source.cjs',
    additionalFixtures: ['paired-update-limits.cjs', 'paired-update-source-data.cjs', 'paired-update-source-activity.cjs', 'paired-update-source-model.cjs'] })
}
