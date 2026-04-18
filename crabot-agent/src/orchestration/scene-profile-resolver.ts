/**
 * Scene Profile Resolver - 场景画像合成纯函数
 *
 * 三路输入（primary / friendOverlay / global）合成为 ComposedSceneProfile：
 * - primary sections 在前
 * - 群聊场景叠加 friend 的 public sections（topic 冲突以 primary 为准）
 * - global sections 追加在末尾
 * - 三者皆空 → 返回 null
 *
 * @see protocol-memory.md v0.2.0
 * @see protocol-agent-v2.md 3.2.2 FrontAgentContext
 */

import type {
  SceneProfile,
  SceneProfileSection,
  ComposedSceneProfile,
} from '../types.js'

interface ComposeInput {
  primary: SceneProfile | null
  friendOverlay: SceneProfile | null
  global: SceneProfile | null
}

export function composeSceneProfile(
  input: ComposeInput,
): ComposedSceneProfile | null {
  const { primary, friendOverlay, global } = input
  if (!primary && !friendOverlay && !global) return null

  const primarySections: SceneProfileSection[] = primary?.sections ?? []
  const primaryTopics = new Set(primarySections.map((s) => s.topic))

  const friendPublic: SceneProfileSection[] = (friendOverlay?.sections ?? [])
    .filter((s) => s.visibility === 'public')
    .filter((s) => !primaryTopics.has(s.topic))

  const globalSections: SceneProfileSection[] = global?.sections ?? []

  const sections = [...primarySections, ...friendPublic, ...globalSections]

  const primaryScene = primary?.scene ?? global?.scene ?? {
    type: 'global' as const,
  }
  const overlaidId =
    friendOverlay && friendOverlay.scene.type === 'friend'
      ? friendOverlay.scene.friend_id
      : undefined

  return {
    primary_label: primary?.label ?? global?.label ?? 'global',
    sections,
    source: {
      primary_scene: primaryScene,
      overlaid_friend_id: overlaidId,
    },
  }
}
