import { expect, it } from 'vitest'
import { formatSlackText } from '../src/format.js'

it('uses native Markdown and keeps source, real mentions and fallback', () => {
  const source = '**标题**\n\n| 问题 | 状态 |\n|---|---|\n| BUG | 已修 |'
  const [part] = formatSlackText(source, ['U1'])
  expect(part.source).toBe('<@U1> ' + source)
  expect(part.blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: '<@U1>' } }, { type: 'markdown', text: source }])
})
it('preserves source across Unicode, code and table continuations', () => {
  const source = '说明😀\n\n```ts\n' + 'const a = 1\n'.repeat(700) + '```\n\n| A | B |\n|---|---|\n' + '| 中文 | 😀 |\n'.repeat(300)
  const parts = formatSlackText(source)
  expect(parts.map(p => p.source).join('')).toBe(source)
  expect(parts.length).toBeGreaterThan(3)
  for (const part of parts) {
    expect(Array.from(part.source).length).toBeLessThanOrEqual(4000)
    const markdown = part.blocks.filter(b => b.type === 'markdown').map(b => b.text).join('')
    expect(Array.from(markdown).length).toBeLessThanOrEqual(4000)
    expect((markdown.match(/^```/gm) || []).length % 2).toBe(0)
  }
})
it('keeps extreme inline tokens literal without dropping bytes', () => {
  const source = '[' + 'x'.repeat(5000) + '](https://example.test)😀'
  const parts = formatSlackText(source)
  expect(parts.map(p => p.source).join('')).toBe(source)
  expect(parts.some(p => p.blocks.some(b => b.type === 'markdown' && b.text.includes('\\[')))).toBe(true)
})
it('limits table rows and columns, repeats headers only in rendered text, and mentions only once', () => {
  const header = '| A | B |\n|---|---|\n'
  const source = header + '| x | y |\n'.repeat(200)
  const parts = formatSlackText(source, ['U1'])
  expect(parts.map(p => p.source).join('')).toBe('<@U1> ' + source)
  const blocks = parts.flatMap(p => p.blocks)
  expect(blocks.filter(b => b.type === 'section')).toHaveLength(1)
  const tables = blocks.filter(b => b.type === 'markdown').map(b => b.text)
  expect(tables).toHaveLength(3)
  for (const text of tables) {
    expect(text.startsWith(header)).toBe(true)
    expect(text.trim().split('\n').length).toBeLessThanOrEqual(101)
  }
  const wide = '|' + ' x |'.repeat(21) + '\n|' + '---|'.repeat(21) + '\n|' + ' y |'.repeat(21) + '\n'
  const literal = formatSlackText(wide)
  expect(literal.map(p => p.source).join('')).toBe(wide)
  expect(literal[0].blocks).toMatchObject([{ type: 'markdown', text: expect.stringContaining('\\|') }])
  const html = formatSlackText('<script>alert(1)</script>')
  expect(html[0].blocks).toMatchObject([{ type: 'markdown', text: expect.stringContaining('\\<script') }])
})
