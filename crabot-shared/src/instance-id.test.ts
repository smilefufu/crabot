import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateInstanceId, INSTANCE_ID_REGEX } from './instance-id.js'

test('接受中文、小写英文、数字、连字符', () => {
  for (const name of ['微信客服', 'feishu-prod', '客服', '微信2号', 'tg-bot-01']) {
    const r = validateInstanceId(name)
    assert.equal(r.ok, true, name)
    if (r.ok) assert.equal(r.id, name)
  }
})

test('拒绝大写、空格、emoji、路径分隔符、点号', () => {
  for (const name of ['Telegram', '微信 客服', '客服🤖', 'wechat/prod', 'a.b', 'con:aux']) {
    assert.equal(validateInstanceId(name).ok, false, name)
  }
})

test('长度边界：2 字符可用，1 字符与 51 字符拒绝', () => {
  assert.equal(validateInstanceId('客服').ok, true)
  assert.equal(validateInstanceId('微').ok, false)
  assert.equal(validateInstanceId('a'.repeat(51)).ok, false)
  assert.equal(validateInstanceId('a'.repeat(50)).ok, true)
})

test('NFD 输入归一化为 NFC 后接受，返回 NFC 形式', () => {
  const nfd = 'café'.normalize('NFD') // e + U+0301，5 个码点
  const r = validateInstanceId(nfd)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.id, 'café'.normalize('NFC'))
    assert.equal(r.id.length, 4)
  }
})

test('空串与纯空白拒绝', () => {
  assert.equal(validateInstanceId('').ok, false)
  assert.equal(validateInstanceId('  ').ok, false)
})

test('导出的正则与校验行为一致', () => {
  assert.equal(INSTANCE_ID_REGEX.test('微信客服'), true)
  assert.equal(INSTANCE_ID_REGEX.test('WeChat'), false)
})
