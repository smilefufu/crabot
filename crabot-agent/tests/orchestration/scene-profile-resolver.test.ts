import { describe, it, expect } from 'vitest'
import { composeSceneProfile } from '../../src/orchestration/scene-profile-resolver.js'
import type { SceneProfile, SceneProfileSection } from '../../src/types.js'

const group: SceneProfile = {
  scene: { type: 'group_session', channel_id: 'c', session_id: 's' },
  label: '开发组群',
  sections: [{ topic: '群职责', body: 'g', visibility: 'private' }],
  created_at: '', updated_at: '',
}
const friend: SceneProfile = {
  scene: { type: 'friend', friend_id: 'f1' },
  label: '张三',
  sections: [{ topic: '职务', body: 'p', visibility: 'public' }],
  created_at: '', updated_at: '',
}
const friendConflict: SceneProfile = {
  scene: { type: 'friend', friend_id: 'f2' },
  label: '李四',
  sections: [{ topic: '群职责', body: 'f', visibility: 'public' }],
  created_at: '', updated_at: '',
}
const global: SceneProfile = {
  scene: { type: 'global' },
  label: 'crabot',
  sections: [{ topic: '基本 persona', body: 'x', visibility: 'private' }],
  created_at: '', updated_at: '',
}

describe('composeSceneProfile', () => {
  it('仅 group：保留 group sections + global', () => {
    const result = composeSceneProfile({ primary: group, friendOverlay: null, global })
    expect(result?.primary_label).toBe('开发组群')
    expect(result?.sections.map((s: SceneProfileSection) => s.topic)).toEqual(['群职责', '基本 persona'])
  })

  it('group + friend 无冲突：叠加 friend public', () => {
    const result = composeSceneProfile({ primary: group, friendOverlay: friend, global })
    expect(result?.sections.map((s: SceneProfileSection) => s.topic)).toEqual(['群职责', '职务', '基本 persona'])
    expect(result?.source.overlaid_friend_id).toBe('f1')
  })

  it('group + friend 冲突：以 group 为准', () => {
    const result = composeSceneProfile({ primary: group, friendOverlay: friendConflict, global })
    const groupSec = result!.sections.find((s: SceneProfileSection) => s.topic === '群职责')!
    expect(groupSec.body).toBe('g')
  })

  it('只有 global', () => {
    const result = composeSceneProfile({ primary: null, friendOverlay: null, global })
    expect(result?.sections.length).toBe(1)
    expect(result?.primary_label).toBe('crabot')
  })

  it('全空 → null', () => {
    expect(composeSceneProfile({ primary: null, friendOverlay: null, global: null })).toBeNull()
  })
})
