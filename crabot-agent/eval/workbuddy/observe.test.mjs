import test from 'node:test'
import assert from 'node:assert/strict'
import { observeResponse } from './observe.mjs'
const bytes = value => new TextEncoder().encode(value)
test('consumer cancellation cannot discard a later usage tail', async () => {
  let cancelled = false
  const upstream = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes('data: {"error":{"message":"overloaded","type":"upstream_error"}}\n\n'))
    setTimeout(() => { if (cancelled) return; controller.enqueue(bytes('data: {"usage":{"prompt_tokens":17,"completion_tokens":3}}\n\ndata: [DONE]\n\n')); controller.close() }, 10)
  }, cancel() { cancelled = true } }))
  const observed = observeResponse(upstream)
  const reader = observed.response.body.getReader(); await reader.read(); await reader.cancel()
  const receipt = await observed.receipt
  assert.equal(cancelled, false); assert.equal(receipt.eof, true)
  assert.deepEqual(receipt.usage, { prompt_tokens: 17, completion_tokens: 3 })
  assert.equal(receipt.error.type, 'upstream_error'); assert.equal(receipt.done, true)
})
test('actual error-only EOF retains unknown usage rather than inventing zero', async () => {
  const observed = observeResponse(new Response('data: {"error":{"message":"overloaded","type":"upstream_error"}}\n\n'))
  const receipt = await observed.receipt
  assert.equal(receipt.eof, true); assert.equal(receipt.usage, undefined)
  assert.equal(receipt.error.message, 'overloaded'); assert.equal(receipt.done, false)
})
test('final unterminated data line and split UTF8 are observed without altering client bytes', async () => {
  const raw = bytes('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":2}}')
  const observed = observeResponse(new Response(new ReadableStream({start(controller) {
    for (const b of raw) controller.enqueue(new Uint8Array([b])); controller.close()
  }})))
  assert.deepEqual(new Uint8Array(await observed.response.arrayBuffer()), raw)
  assert.equal((await observed.receipt).usage.prompt_tokens, 7)
})
test('non-stream HTTP errors preserve the exact body and status', async () => {
  const body = '{"error":{"type":"insufficient_quota"}}'
  const observed = observeResponse(new Response(body, {status:402,headers:{'content-type':'application/json'}}))
  assert.equal(await observed.response.text(), body)
  const receipt = await observed.receipt
  assert.equal(receipt.httpStatus, 402); assert.equal(receipt.bodyText, body)
  assert.equal(receipt.error.type, 'insufficient_quota')
})
test('transport interruption remains distinct from normal EOF', async () => {
  const observed = observeResponse(new Response(new ReadableStream({start(controller) {controller.error(new Error('socket lost'))}})))
  const receipt = await observed.receipt
  assert.equal(receipt.eof, false); assert.match(receipt.transportError, /socket lost/)
  await assert.rejects(observed.response.text(), /socket lost/)
})

test('successful non-stream judge usage is observed and the JSON stays unchanged', async () => {
  const body = '{"choices":[{"message":{"content":"pass"}}],"usage":{"prompt_tokens":25,"completion_tokens":4}}'
  const observed = observeResponse(new Response(body), undefined, false)
  assert.equal(await observed.response.text(), body)
  assert.deepEqual((await observed.receipt).usage, {prompt_tokens:25,completion_tokens:4})
})
