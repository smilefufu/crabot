#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.147.0'}\n`)
  process.exit(0)
}

if (!argv.includes('app-server')) process.exit(2)

const mode = process.env.FAKE_APP_SERVER_MODE ?? 'happy'
const forkThreadId = process.env.FAKE_FORK_THREAD_ID ?? '019d0000-0000-7000-8000-000000000001'
const turnId = process.env.FAKE_TURN_ID ?? '019d0000-0000-7000-8000-000000000002'
const delayMs = Number(process.env.FAKE_COMPLETION_DELAY_MS ?? '20')
const terminationFile = process.env.FAKE_TERMINATION_FILE

function recordTermination(signal) {
  if (terminationFile) appendFileSync(terminationFile, `${process.pid}:${signal}\n`)
  process.exit(0)
}
process.on('SIGTERM', () => recordTermination('SIGTERM'))
process.on('SIGINT', () => recordTermination('SIGINT'))

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function error(id, message, code = -32600) {
  send({ id, error: { code, message } })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (mode === 'hang_initialize') return
    send({
      id: message.id,
      result: {
        userAgent: 'fake-codex-app-server/0.147.0',
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: 'unix',
        platformOs: 'test',
      },
    })
    return
  }
  if (message.method === 'initialized') {
    process.stderr.write('fake app-server initialized\n')
    send({ method: 'unrelated/notification', params: { ignored: true } })
    return
  }
  if (message.method === 'thread/list') {
    if (mode === 'unsupported') {
      error(message.id, 'method not found', -32601)
      return
    }
    const parentThreadId = message.params?.parentThreadId
    send({
      id: message.id,
      result: {
        data: mode === 'children' && typeof parentThreadId === 'string' ? [{
          id: process.env.FAKE_CHILD_THREAD_ID ?? '019d0000-0000-7000-8000-000000000003',
          parentThreadId,
          preview: '原生子 Agent 任务',
          status: { type: 'idle' },
          agentNickname: '研究助手',
          agentRole: 'research',
          createdAt: 1_770_000_000,
          updatedAt: 1_770_000_060,
        }] : [],
        nextCursor: null,
      },
    })
    return
  }
  if (message.method === 'thread/items/list') {
    if (mode === 'unsupported') {
      error(message.id, 'method not found', -32601)
      return
    }
    const childThreadId = process.env.FAKE_CHILD_THREAD_ID ?? '019d0000-0000-7000-8000-000000000003'
    send({
      id: message.id,
      result: {
        data: mode === 'children' && message.params?.threadId === childThreadId ? [
          { turnId: 'turn-child', item: { type: 'userMessage', content: [{ text: '检查原生记录' }] } },
          { turnId: 'turn-child', item: { type: 'commandExecution', command: 'pwd' } },
          { turnId: 'turn-child', item: { type: 'agentMessage', text: '原生子 Agent 已完成' } },
        ] : [],
        nextCursor: null,
      },
    })
    return
  }
  if (message.method === 'thread/fork') {
    if (mode === 'unsupported') {
      error(message.id, 'method not found', -32601)
      return
    }
    if (message.params?.threadId === '00000000-0000-0000-0000-000000000001') {
      setTimeout(() => error(message.id, `no rollout found for thread id ${message.params.threadId}`), 20)
      return
    }
    if (mode === 'hang_fork') return
    if (mode === 'fork_error') {
      error(message.id, 'fork refused')
      return
    }
    if (mode === 'bad_fork_shape') {
      send({ id: message.id, result: { thread: {} } })
      return
    }
    send({ id: message.id, result: { thread: { id: forkThreadId } } })
    return
  }
  if (message.method === 'turn/start') {
    if (message.params?.threadId === '00000000-0000-0000-0000-000000000002') {
      error(message.id, `thread not found: ${message.params.threadId}`)
      return
    }
    if (mode === 'turn_error') {
      error(message.id, 'turn rejected')
      return
    }
    if (mode === 'bad_turn_shape') {
      send({ id: message.id, result: { turn: {} } })
      return
    }
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
    setTimeout(() => {
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: forkThreadId, turnId, itemId: 'item-1', delta: process.env.FAKE_REPLY ?? '侧问回答' },
      })
      send({
        method: 'turn/completed',
        params: {
          threadId: forkThreadId,
          turn: {
            id: turnId,
            status: mode === 'turn_failed' ? 'failed' : 'completed',
            items: [],
            ...(mode === 'turn_failed' ? { error: { message: 'simulated turn failure' } } : {}),
          },
        },
      })
    }, delayMs)
  }
})
