import { describe, it, expect } from 'vitest'
import { buildImageCapability } from '../../src/prompts/agent-sections.js'
import { assembleAgentPrompt } from '../../src/prompts/assemble-agent.js'

describe('buildImageCapability', () => {
  it('available state names the tool and delivery path', () => {
    const s = buildImageCapability(true)
    expect(s).toContain('generate_image')
    expect(s).toContain('send_message')
  })
  it('unavailable state guides to configure and says auto-effective', () => {
    const s = buildImageCapability(false)
    expect(s).toContain('配置')
    expect(s).toContain('下一个任务自动生效')
  })
})

describe('assembleAgentPrompt', () => {
  it('injects an image capability section (unavailable by default)', () => {
    const p = assembleAgentPrompt({ goalModeEnabled: false })
    expect(p).toContain('生图能力')
  })
  it('injects available image section when flag set', () => {
    const p = assembleAgentPrompt({ goalModeEnabled: false, imageCapability: { available: true } })
    expect(p).toContain('generate_image')
  })
})
