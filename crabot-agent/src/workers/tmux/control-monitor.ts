import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import os from 'node:os'
import { dirname, join } from 'node:path'

export type PasteReadinessState = 'ready' | 'not_ready' | 'unknown'

export interface PasteReadiness {
  state: PasteReadinessState
  observed_at?: string
}

export interface TmuxControlEndpoint {
  socket_path: string
  monitor_id: string
}

const ENABLE = Buffer.from('\u001b[?2004h', 'ascii')
const DISABLE = Buffer.from('\u001b[?2004l', 'ascii')
const SUFFIX_BYTES = Math.max(ENABLE.length, DISABLE.length) - 1

/**
 * Consume one raw pipe-pane chunk. Only the finite suffix is retained so a
 * bracketed-paste control sequence split between chunks is still recognized.
 */
export function advancePasteReadiness(
  previous: PasteReadiness & { suffix?: Buffer },
  chunk: Buffer,
  observedAt = new Date().toISOString(),
): PasteReadiness & { suffix: Buffer } {
  const input = previous.suffix?.length ? Buffer.concat([previous.suffix, chunk]) : chunk
  let offset = 0
  let state = previous.state
  let observed_at = previous.observed_at

  for (;;) {
    const enabledAt = input.indexOf(ENABLE, offset)
    const disabledAt = input.indexOf(DISABLE, offset)
    if (enabledAt < 0 && disabledAt < 0) break
    if (disabledAt < 0 || (enabledAt >= 0 && enabledAt < disabledAt)) {
      state = 'ready'
      offset = enabledAt + ENABLE.length
    } else {
      state = 'not_ready'
      offset = disabledAt + DISABLE.length
    }
    observed_at = observedAt
  }

  return {
    state,
    ...(observed_at ? { observed_at } : {}),
    suffix: Buffer.from(input.subarray(Math.max(0, input.length - SUFFIX_BYTES))),
  }
}

export async function createTmuxControlEndpoint(): Promise<TmuxControlEndpoint> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), 'crabot-tmux-control-'))
  await fs.chmod(dir, 0o700)
  return { socket_path: join(dir, 'state.sock'), monitor_id: randomUUID() }
}

export async function removeTmuxControlEndpoint(endpoint: TmuxControlEndpoint): Promise<void> {
  await fs.rm(dirname(endpoint.socket_path), { recursive: true, force: true }).catch(() => {})
}

/** The pipe-pane command deliberately has no durable raw-output destination. */
export function controlMonitorPipeCommand(endpoint: TmuxControlEndpoint): string {
  return `env -i ${shQuote(process.execPath)} --input-type=module --eval ${shQuote(MONITOR_PROGRAM)} ${shQuote(endpoint.socket_path)} ${shQuote(endpoint.monitor_id)}`
}

/** Endpoint failures are intentionally represented as unknown, never as stale ready. */
export async function readTmuxControlState(endpoint: TmuxControlEndpoint, timeoutMs = 250): Promise<PasteReadiness> {
  return new Promise((resolve) => {
    let settled = false
    let response = ''
    const finish = (value: PasteReadiness) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const client = net.createConnection(endpoint.socket_path)
    const timer = setTimeout(() => {
      client.destroy()
      finish({ state: 'unknown' })
    }, timeoutMs)
    timer.unref?.()
    client.setEncoding('utf-8')
    client.once('connect', () => client.end(`${endpoint.monitor_id}\n`))
    client.on('data', (chunk: string) => { response += chunk })
    client.once('error', () => finish({ state: 'unknown' }))
    client.once('end', () => {
      try {
        const parsed = JSON.parse(response) as { monitor_id?: unknown; state?: unknown; observed_at?: unknown }
        if (parsed.monitor_id !== endpoint.monitor_id) return finish({ state: 'unknown' })
        if (parsed.state !== 'ready' && parsed.state !== 'not_ready' && parsed.state !== 'unknown') {
          return finish({ state: 'unknown' })
        }
        return finish({
          state: parsed.state,
          ...(typeof parsed.observed_at === 'string' ? { observed_at: parsed.observed_at } : {}),
        })
      } catch {
        finish({ state: 'unknown' })
      }
    })
  })
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Kept self-contained because this executes as the pipe-pane consumer after the
// application TypeScript has been compiled. It exposes only readiness state.
const MONITOR_PROGRAM = String.raw`
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const [socketPath, monitorId] = process.argv.slice(-2);
const enable = Buffer.from('\x1b[?2004h', 'ascii');
const disable = Buffer.from('\x1b[?2004l', 'ascii');
const suffixBytes = Math.max(enable.length, disable.length) - 1;
let state = 'unknown';
let observedAt;
let suffix = Buffer.alloc(0);
let closed = false;
function consume(chunk) {
  const input = suffix.length ? Buffer.concat([suffix, chunk]) : chunk;
  let offset = 0;
  for (;;) {
    const enabledAt = input.indexOf(enable, offset);
    const disabledAt = input.indexOf(disable, offset);
    if (enabledAt < 0 && disabledAt < 0) break;
    if (disabledAt < 0 || (enabledAt >= 0 && enabledAt < disabledAt)) {
      state = 'ready'; offset = enabledAt + enable.length;
    } else {
      state = 'not_ready'; offset = disabledAt + disable.length;
    }
    observedAt = new Date().toISOString();
  }
  suffix = Buffer.from(input.subarray(Math.max(0, input.length - suffixBytes)));
}
function cleanup() {
  if (closed) return;
  closed = true;
  server.close();
  try { fs.rmSync(path.dirname(socketPath), { recursive: true, force: true }); } catch {}
}
const server = net.createServer((socket) => {
  let request = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { request += chunk; });
  socket.on('end', () => {
    if (request.trim() !== monitorId) return socket.end(JSON.stringify({ error: 'monitor_id_mismatch' }));
    socket.end(JSON.stringify({ monitor_id: monitorId, state, ...(observedAt ? { observed_at: observedAt } : {}) }));
  });
});
server.listen(socketPath, () => { try { fs.chmodSync(socketPath, 0o600); } catch {} });
process.stdin.on('data', consume);
process.stdin.once('end', cleanup);
process.once('SIGTERM', cleanup);
process.once('SIGINT', cleanup);
`
