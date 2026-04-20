import type { RuntimeSceneProfile, SceneProfile } from '../types.js'

export function buildRuntimeSceneProfile(
  profile: SceneProfile | null,
): RuntimeSceneProfile | null {
  if (!profile) return null

  return {
    label: profile.label,
    abstract: profile.abstract,
    overview: profile.overview,
    content: profile.content,
    source: {
      scene: profile.scene,
    },
  }
}
