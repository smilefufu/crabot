import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { pcm16Wave, speechWaveToPcm, synthesizeAudio, transcribeAudio } from './audio-client.js'
import type { AudioServiceConnection } from './voice.js'

test('complete speech WAV is validated before consumption; partial/multiple/empty/long WAV fails', () => {
  const pcm = Buffer.alloc(480, 1)
  const wave = pcm16Wave(pcm, 24000)
  assert.deepEqual(speechWaveToPcm(wave), pcm)
  for (const data of [wave.subarray(0, wave.length - 1), Buffer.concat([wave, wave]), pcm16Wave(Buffer.alloc(100), 24000), pcm16Wave(Buffer.alloc(100, 1), 16000), pcm16Wave(Buffer.alloc(960002, 1), 24000)]) {
    assert.throws(() => speechWaveToPcm(data))
  }
})

test('MLX and basic OpenAI requests keep distinct schemas; multipart ASR returns only text', async () => {
  const requests: Array<{ url: string; body: string; auth?: string }> = []
  const wave = pcm16Wave(Buffer.alloc(480, 1), 24000)
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push({ url: req.url!, body: Buffer.concat(chunks).toString('utf8'), auth: req.headers.authorization })
    if (req.url === '/v1/audio/transcriptions') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: '不要开灯', segments: [{ speaker: 'model-guess' }] })) }
    else res.end(wave)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const service: AudioServiceConnection = { provider_id: 'test', kind: 'self_hosted', format: 'mlx-audio-http', endpoint: `http://127.0.0.1:${port}`, model_id: 'kokoro', voice: 'test-voice', api_key: 'marker' }
  try {
    assert.deepEqual(await synthesizeAudio(service, '好的', AbortSignal.timeout(1000)), wave.subarray(44))
    assert.deepEqual(JSON.parse(requests[0].body), { model: 'kokoro', voice: 'test-voice', input: '好的', response_format: 'wav', lang_code: 'z', stream: false })
    const openai = { ...service, format: 'openai-audio' as const, endpoint: service.endpoint + '/v1' }
    await synthesizeAudio(openai, '好的', AbortSignal.timeout(1000))
    assert.equal(JSON.parse(requests[1].body).lang_code, undefined)
    assert.equal(JSON.parse(requests[1].body).stream, undefined)
    assert.equal(await transcribeAudio(openai, Buffer.alloc(640, 1), AbortSignal.timeout(1000)), '不要开灯')
    assert.equal(requests[2].url, '/v1/audio/transcriptions')
    assert.match(requests[2].body, /name="file"; filename="turn.wav"/)
    assert.match(requests[2].body, /RIFF/)
    assert.equal(requests[2].auth, 'Bearer marker')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('HTTP 200 followed by truncated speech is a failed delivery and is requested only once', async () => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++; res.writeHead(200, { 'Content-Length': '1000' }); res.flushHeaders(); res.write('RIFF'); res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await assert.rejects(synthesizeAudio({ provider_id: 'test', kind: 'cloud', format: 'openai-audio', endpoint: `http://127.0.0.1:${port}`, model_id: 'tts', voice: 'test' }, '好的', AbortSignal.timeout(1000)))
    assert.equal(requests, 1)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
