import type { VoiceModelVersions } from './voice.js'

// Frozen, independently tested first-phase assets; INT8 segmentation is not interchangeable.
export const VOICE_MODEL_VERSIONS: Readonly<VoiceModelVersions> = {
  segmentation: 'pyannote-segmentation-3.0-fp32@220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
  embedding: 'campplus-zh@f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
}
