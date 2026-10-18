import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'

// Evaluate only the actual input function. Never import a start/password command
// body: these tests must not start MM, read profiles or rotate real credentials.
function prompter(script, input, write, exit = () => assert.fail('must not exit in this input scenario')) {
  const source = fs.readFileSync(new URL('../../' + script, import.meta.url), 'utf8')
  const start = source.indexOf('function createPrompter() {'), end = source.indexOf('\n}\n', start) + 3
  assert.ok(start > 0 && end > start)
  return vm.runInNewContext(source.slice(start, end) + ';createPrompter()', {
    process: { stdin: input, stdout: { write }, exit }, createInterface,
  })
}
function terminal(raw = false) {
  return Object.assign(new EventEmitter(), { isTTY: true, isRaw: raw, setEncoding() {},
    setRawMode(value) { this.isRaw = value }, resume() {}, pause() {} })
}
for (const script of ['start.mjs', 'password.mjs']) {
  test(script + ': raw mode and listener are ready before a visible secret prompt can be answered', async () => {
    const input = terminal(), output = []
    const prompt = prompter(script, input, value => {
      output.push(value)
      if (value !== '\n') {
        assert.equal(input.isRaw, true, 'visible prompt must never precede echo suppression')
        assert.equal(input.listenerCount('data'), 1, 'immediate input must have a listener')
        input.emit('data', 's'); input.emit('data', 'e'); input.emit('data', 'c'); input.emit('data', '\r')
      }
    })
    assert.equal(await prompt.ask('Secret: '), 'sec'); prompt.close()
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0)
    assert.equal(output.join('').includes('sec'), false)
  })
  test(script + ': pasted password and Enter in one input chunk complete and preserve the original terminal mode', async () => {
    for (const raw of [false, true]) {
      const input = terminal(raw), prompt = prompter(script, input, () => {})
      const result = prompt.ask('Secret: ')
      input.emit('data', 'private-pass\r')
      let timer
      try {
        assert.equal(await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pasted input did not finish')), 50) })]), 'private-pass')
      } finally { clearTimeout(timer); prompt.close() }
      assert.equal(input.isRaw, raw); assert.equal(input.listenerCount('data'), 0)
    }
  })
  test(script + ': cancellation and an unavailable output restore echo before exiting', async () => {
    const input = terminal(), cancelled = new Error('controlled exit')
    const prompt = prompter(script, input, () => {}, code => {
      assert.equal(code, 1); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0); throw cancelled
    })
    prompt.ask('Secret: ')
    assert.throws(() => input.emit('data', '\x03'), error => error === cancelled)
    const broken = prompter(script, input, () => { throw new Error('controlled output failure') })
    await assert.rejects(broken.ask('Secret: '), /controlled output failure/)
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0)
  })
  test(script + ': split UTF-8 chunks and pasted backspace are decoded without echoing', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value } })
    let output = ''
    const prompt = prompter(script, input, value => { output += value }), result = prompt.ask('Secret: ')
    const first = Buffer.from('密')
    input.write(first.subarray(0, 1)); input.write(first.subarray(1)); input.end('码abx\bc\r')
    assert.equal(await result, '密码abc'); prompt.close()
    assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0); assert.equal(output.includes('密码'), false)
  })
  test(script + ': existing non-TTY queued lines and EOF remain compatible', async () => {
    const input = new PassThrough(), output = [], prompt = prompter(script, input, value => output.push(value))
    input.end('first-secret\nsecond-secret\n')
    assert.equal(await prompt.ask('First: '), 'first-secret')
    assert.equal(await prompt.ask('Second: '), 'second-secret')
    assert.equal(await prompt.ask('Empty: '), '')
    prompt.close(); assert.equal(output.join('').includes('secret'), false)
  })
}
