import { describe, it, expect } from 'vitest'
import { buildRuntimeSceneProfile } from '../../src/orchestration/scene-profile-resolver.js'
import type { SceneProfile } from '../../src/types.js'

describe('buildRuntimeSceneProfile', () => {
  it('builds runtime scene profile from one scene only', () => {
    const profile: SceneProfile = {
      scene: { type: 'group_session', channel_id: 'wechat', session_id: 'group-1' },
      label: 'video-app 项目群',
      abstract: '项目群画像',
      overview: '处理技术支持与排障',
      content: '进入本群后先做技术支持与问题排查。',
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    }

    expect(buildRuntimeSceneProfile(profile)).toEqual({
      label: 'video-app 项目群',
      abstract: '项目群画像',
      overview: '处理技术支持与排障',
      content: '进入本群后先做技术支持与问题排查。',
      source: {
        scene: { type: 'group_session', channel_id: 'wechat', session_id: 'group-1' },
      },
    })
  })

  it('returns null when scene profile is missing', () => {
    expect(buildRuntimeSceneProfile(null)).toBeNull()
  })
})
