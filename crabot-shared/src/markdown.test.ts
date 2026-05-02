import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMarkdownFormat,
  decideMarkdownEnabled,
  hasMarkdownMarkers,
  markdownToTelegramHtml,
} from './markdown.js'

test('parseMarkdownFormat 接受合法值，其余回退默认', () => {
  assert.equal(parseMarkdownFormat('on'), 'on')
  assert.equal(parseMarkdownFormat('OFF'), 'off')
  assert.equal(parseMarkdownFormat(' auto '), 'auto')
  assert.equal(parseMarkdownFormat(undefined), 'auto')
  assert.equal(parseMarkdownFormat(null), 'auto')
  assert.equal(parseMarkdownFormat('xxx'), 'auto')
  assert.equal(parseMarkdownFormat('xxx', 'off'), 'off')
})

test('decideMarkdownEnabled on/off 强制覆盖', () => {
  assert.equal(decideMarkdownEnabled('on', '纯文本'), true)
  assert.equal(decideMarkdownEnabled('off', '**bold**'), false)
})

test('decideMarkdownEnabled auto 检测 markdown 标记', () => {
  assert.equal(decideMarkdownEnabled('auto', '**bold**'), true)
  assert.equal(decideMarkdownEnabled('auto', '`code`'), true)
  assert.equal(decideMarkdownEnabled('auto', '# 标题'), true)
  assert.equal(decideMarkdownEnabled('auto', '- 列表项'), true)
  assert.equal(decideMarkdownEnabled('auto', '1. 第一'), true)
  assert.equal(decideMarkdownEnabled('auto', '[名字](https://x.com)'), true)
  assert.equal(decideMarkdownEnabled('auto', '> 引用'), true)
  assert.equal(decideMarkdownEnabled('auto', '普通的纯文本消息'), false)
  assert.equal(decideMarkdownEnabled('auto', 'snake_case_var'), false)
  assert.equal(decideMarkdownEnabled('auto', '价格 *100*'), true)
  assert.equal(decideMarkdownEnabled('auto', '价格*100'), false)
})

test('hasMarkdownMarkers 与 decideMarkdownEnabled(auto) 一致', () => {
  for (const sample of ['plain', '**bold**', 'no markers here']) {
    assert.equal(hasMarkdownMarkers(sample), decideMarkdownEnabled('auto', sample))
  }
})

test('markdownToTelegramHtml: 加粗 / 斜体 / 删除线 / 行内代码', () => {
  assert.equal(
    markdownToTelegramHtml('**bold** and *italic* and ~~gone~~'),
    '<b>bold</b> and <i>italic</i> and <s>gone</s>'
  )
  assert.equal(markdownToTelegramHtml('`code`'), '<code>code</code>')
  assert.equal(markdownToTelegramHtml('**_bold_**'), '<b><i>bold</i></b>')
})

test('markdownToTelegramHtml: 三星 *** 转 b+i', () => {
  assert.equal(markdownToTelegramHtml('***x***'), '<b><i>x</i></b>')
})

test('markdownToTelegramHtml: 标题降级为加粗', () => {
  assert.equal(markdownToTelegramHtml('# 一级'), '<b>一级</b>')
  assert.equal(markdownToTelegramHtml('### 三级'), '<b>三级</b>')
})

test('markdownToTelegramHtml: 链接', () => {
  assert.equal(
    markdownToTelegramHtml('[Crabot](https://example.com)'),
    '<a href="https://example.com">Crabot</a>'
  )
})

test('markdownToTelegramHtml: 列表项替换为圆点', () => {
  assert.equal(markdownToTelegramHtml('- a\n- b'), '• a\n• b')
  assert.equal(markdownToTelegramHtml('* a\n+ b'), '• a\n• b')
})

test('markdownToTelegramHtml: 三反引号代码块带语言', () => {
  const out = markdownToTelegramHtml('```ts\nconst x = 1;\n```')
  assert.equal(out, '<pre><code class="language-ts">const x = 1;</code></pre>')
})

test('markdownToTelegramHtml: 三反引号代码块不带语言', () => {
  const out = markdownToTelegramHtml('```\nplain block\n```')
  assert.equal(out, '<pre>plain block</pre>')
})

test('markdownToTelegramHtml: 代码内的特殊字符 HTML 转义', () => {
  assert.equal(
    markdownToTelegramHtml('`<a>&b`'),
    '<code>&lt;a&gt;&amp;b</code>'
  )
})

test('markdownToTelegramHtml: 普通文本里的 < > & 也要转义', () => {
  assert.equal(markdownToTelegramHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d')
})

test('markdownToTelegramHtml: 不会把 snake_case 当斜体', () => {
  assert.equal(markdownToTelegramHtml('use snake_case_var here'), 'use snake_case_var here')
})

test('markdownToTelegramHtml: 引用块', () => {
  const out = markdownToTelegramHtml('> 一行\n> 二行')
  assert.match(out, /<blockquote>一行\n二行<\/blockquote>/)
})

test('markdownToTelegramHtml: 空字符串安全', () => {
  assert.equal(markdownToTelegramHtml(''), '')
})

test('markdownToTelegramHtml: 输入里的 U+0001 / U+0002 哨兵被剥掉，不能伪造占位符', () => {
  const malicious = 'CB0 plain'
  const out = markdownToTelegramHtml(malicious)
  assert.ok(!out.includes(''), 'output should contain no U+0001')
  assert.ok(!out.includes(''), 'output should contain no U+0002')
  assert.equal(out, 'CB0 plain')
})

test('markdownToTelegramHtml: 链接 URL 中的引号被替换', () => {
  const out = markdownToTelegramHtml('[x](https://e.com/?a="b")')
  assert.match(out, /href="https:\/\/e\.com\/\?a=%22b%22"/)
})

test('markdownToTelegramHtml: GFM 表格被裹进 <pre> 等宽块', () => {
  const md = '| 类型 | 占比 | 草案描述 |\n|---|---:|---|\n| regime 0 | 68.26% | 平衡/过渡 |\n| regime 1 | 31.74% | 高波动/扩张 |'
  const out = markdownToTelegramHtml(md)
  assert.ok(out.startsWith('<pre>'), `expected <pre> wrapping, got: ${out}`)
  assert.ok(out.endsWith('</pre>'), `expected </pre> closing, got: ${out}`)
  // 列分隔符
  assert.ok(out.includes(' │ '), 'expected box-drawing column separator')
  // 表头 + 第一行数据都在
  assert.ok(out.includes('类型'))
  assert.ok(out.includes('regime 0'))
  assert.ok(out.includes('68.26%'))
  // 右对齐：占比那一列数字应该有前导空格
  assert.match(out, / +68\.26%/)
})

test('markdownToTelegramHtml: 没有数据行的伪表格按原文穿透', () => {
  const md = '| a | b |\n|---|---|\n这是普通文本'
  const out = markdownToTelegramHtml(md)
  assert.ok(!out.includes('<pre>'), `should NOT render as table: ${out}`)
  assert.ok(out.includes('| a | b |'))
})

test('markdownToTelegramHtml: 表格单元格里的 < > & 被 HTML escape', () => {
  const md = '| col |\n|---|\n| <a&b> |'
  const out = markdownToTelegramHtml(md)
  assert.ok(out.includes('&lt;a&amp;b&gt;'))
  assert.ok(!out.includes('<a&b>'))
})

test('markdownToTelegramHtml: 表格不影响周围的 markdown 渲染', () => {
  const md = '**重点**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n_后文_'
  const out = markdownToTelegramHtml(md)
  assert.ok(out.includes('<b>重点</b>'))
  assert.ok(out.includes('<i>后文</i>'))
  assert.ok(out.includes('<pre>'))
})
