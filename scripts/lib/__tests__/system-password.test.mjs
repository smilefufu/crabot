import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readSystemInitialPassword } from '../system-password.mjs'

function terminal(answers, { raw = false, tty = true } = {}) {
  const input = Object.assign(new EventEmitter(), { isRaw: raw, isTTY: tty,
    setEncoding() {}, setRawMode(value) { this.isRaw = value }, resume() {}, pause() {} })
  let text = '', index = 0
  const output = { write(value) {
    text += value
    if (value.endsWith('：')) {
      assert.equal(input.isRaw, true, 'terminal must disable echo before exposing a password prompt')
      assert.equal(input.listenerCount('data'), 1, 'input must be listening before the prompt can be answered')
      queueMicrotask(() => input.emit('data', answers[index++]))
    }
  } }
  return { input, output, text: () => text, count: () => index }
}

test('both administrator password prompts are ready before immediate input and never echo secrets', async () => {
  const terminalState = terminal(['private-password\r', 'private-password\r'])
  assert.equal(await readSystemInitialPassword(terminalState), 'private-password')
  assert.equal(terminalState.text().includes('private-password'), false)
  assert.equal(terminalState.count(), 2)
  assert.equal(terminalState.input.isRaw, false)
  assert.equal(terminalState.input.listenerCount('data'), 0)
})

test('cancellation restores the original terminal mode and removes the password handler', async () => {
  for (const raw of [false, true]) {
    const terminalState = terminal(['\u0003'], { raw })
    await assert.rejects(readSystemInitialPassword(terminalState), /已取消开通/)
    assert.equal(terminalState.input.isRaw, raw)
    assert.equal(terminalState.input.listenerCount('data'), 0)
  }
})

test('initial password is never accepted from noninteractive input', async () => {
  const terminalState = terminal([], { tty: false })
  await assert.rejects(readSystemInitialPassword(terminalState), /管理员交互终端/)
  assert.equal(terminalState.text(), ''); assert.equal(terminalState.input.listenerCount('data'), 0)
})

for (const answers of [['abc\r', 'abc\r'], ['private-one\r', 'private-two\r']]) {
  test('invalid or mismatched passwords leave the terminal usable without exposing input: ' + answers[0].length, async () => {
    const terminalState = terminal(answers)
    await assert.rejects(readSystemInitialPassword(terminalState), /两次输入须相同/)
    assert.equal(terminalState.input.isRaw, false)
    for (const answer of answers) assert.equal(terminalState.text().includes(answer.trim()), false)
    for (const event of ['data', 'end', 'error']) assert.equal(terminalState.input.listenerCount(event), 0)
  })
}

for (const event of ['end', 'error']) test('terminal ' + event + ' cannot leave an active secret-input listener', async () => {
  const terminalState = terminal([])
  terminalState.output.write = value => { if (value.endsWith('：')) queueMicrotask(() => terminalState.input.emit(event, new Error('private-detail'))) }
  await assert.rejects(readSystemInitialPassword(terminalState), /密码输入已中断/)
  assert.equal(terminalState.input.isRaw, false)
  for (const name of ['data', 'end', 'error']) assert.equal(terminalState.input.listenerCount(name), 0)
})
