import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateInstanceId, INSTANCE_ID_REGEX } from './instance-id.js'

test('接受中文/日文汉字、小写英文、数字、连字符', () => {
  for (const name of ['微信客服', '飞书测试', '漢字', 'feishu-prod', '客服', '微信2号', 'tg-bot-01']) {
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

test('拒绝会 fold 碰撞 / NFD 分解的非中文字符（希腊 / 带重音拉丁 / 韩文 / 假名）', () => {
  // 收紧字符集从根上排除这些：Han 无大小写、单码点不分解，故无 fold 碰撞、无 NFC/NFD 错位
  for (const name of ['aσ', 'aς', 'café', '한글', 'ぬこ', 'Ω-2']) {
    assert.equal(validateInstanceId(name).ok, false, name)
  }
})

test('长度边界：2 字符可用，1 字符与 51 字符拒绝', () => {
  assert.equal(validateInstanceId('客服').ok, true)
  assert.equal(validateInstanceId('微').ok, false)
  assert.equal(validateInstanceId('a'.repeat(51)).ok, false)
  assert.equal(validateInstanceId('a'.repeat(50)).ok, true)
})

test('合法中文名 NFC 归一化是恒等（汉字单码点不分解）', () => {
  const r = validateInstanceId('微信客服')
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.id, '微信客服'.normalize('NFC'))
})

test('空串与纯空白拒绝', () => {
  assert.equal(validateInstanceId('').ok, false)
  assert.equal(validateInstanceId('  ').ok, false)
})

test('导出的正则与校验行为一致', () => {
  assert.equal(INSTANCE_ID_REGEX.test('微信客服'), true)
  assert.equal(INSTANCE_ID_REGEX.test('WeChat'), false)
})
