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

export type TmuxControlDiagnosticEvent =
  | 'monitor_started'
  | 'server_listening'
  | 'readiness_changed'
  | 'stdin_end'
  | 'signal'
  | 'server_error'
  | 'uncaught_exception'
  | 'unhandled_rejection'
  | 'cleanup'
  | 'process_exit'
  | 'pipe_attached'
  | 'input_surface_unavailable'
  | 'paste_invoked'
  | 'paste_returned'
  | 'paste_error'
  | 'submit_invoked'
  | 'submit_returned'
  | 'submit_error'
  | 'input_commit_capture'

/** Append a small, durable control diagnostic without capturing raw terminal output. */
export async function appendTmuxControlDiagnostic(
  logPath: string | undefined,
  event: TmuxControlDiagnosticEvent,
  details: Record<string, unknown> = {},
): Promise<void> {
  if (!logPath) return
  const record = { at: new Date().toISOString(), event, ...details }
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 }).catch(() => {})
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

/** The pipe-pane command never persists raw output; it may persist lifecycle diagnostics. */
export function controlMonitorPipeCommand(endpoint: TmuxControlEndpoint, diagnosticLogPath?: string): string {
  return `env -i ${shQuote(process.execPath)} --input-type=module --eval ${shQuote(MONITOR_PROGRAM)} ${shQuote(endpoint.socket_path)} ${shQuote(endpoint.monitor_id)} ${shQuote(diagnosticLogPath ?? '')}`
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
// application TypeScript has been compiled. It exposes bracketed-paste readiness only.
const MONITOR_PROGRAM = String.raw`
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const [socketPath, monitorId, diagnosticLogPath = ''] = process.argv.slice(-3);
const enable = Buffer.from('\x1b[?2004h', 'ascii');
const disable = Buffer.from('\x1b[?2004l', 'ascii');
const suffixBytes = Math.max(enable.length, disable.length) - 1;
let state = 'unknown';
let observedAt;
let suffix = Buffer.alloc(0);
let closed = false;
function diagnostic(event, details = {}) {
  if (!diagnosticLogPath) return;
  try {
    fs.appendFileSync(diagnosticLogPath, JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {}
}
diagnostic('monitor_started', { pid: process.pid, monitor_id: monitorId, socket_path: socketPath });
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
    diagnostic('readiness_changed', { state, observed_at: observedAt });
  }
  suffix = Buffer.from(input.subarray(Math.max(0, input.length - suffixBytes)));
}
function cleanup(reason = 'unknown') {
  if (closed) return;
  closed = true;
  diagnostic('cleanup', { reason, state, observed_at: observedAt });
  server.close();
  try { fs.rmSync(path.dirname(socketPath), { recursive: true, force: true }); } catch {}
}
const server = net.createServer((socket) => {
  let request = '';
  let handled = false;
  socket.setEncoding('utf8');
  const handleRequest = () => {
    if (handled || !request.includes('\n')) return;
    handled = true;
    const value = request.slice(0, request.indexOf('\n')).trim();
    if (value !== monitorId) return socket.end(JSON.stringify({ error: 'monitor_id_mismatch' }));
    socket.end(JSON.stringify({ monitor_id: monitorId, state, ...(observedAt ? { observed_at: observedAt } : {}) }));
  };
  socket.on('data', (chunk) => { request += chunk; handleRequest(); });
  socket.on('end', handleRequest);
});
server.once('error', (error) => {
  diagnostic('server_error', { error: String(error && error.message ? error.message : error) });
  cleanup('server_error');
  process.exitCode = 1;
});
server.listen(socketPath, () => {
  try { fs.chmodSync(socketPath, 0o600); } catch {}
  diagnostic('server_listening', { pid: process.pid, socket_path: socketPath });
});
process.stdin.on('data', consume);
process.stdin.once('end', () => { diagnostic('stdin_end'); cleanup('stdin_end'); });
process.once('SIGTERM', () => { diagnostic('signal', { signal: 'SIGTERM' }); cleanup('SIGTERM'); });
process.once('SIGINT', () => { diagnostic('signal', { signal: 'SIGINT' }); cleanup('SIGINT'); });
process.once('uncaughtException', (error) => { diagnostic('uncaught_exception', { error: String(error && error.stack ? error.stack : error) }); cleanup('uncaught_exception'); process.exitCode = 1; });
process.once('unhandledRejection', (reason) => { diagnostic('unhandled_rejection', { error: String(reason) }); cleanup('unhandled_rejection'); process.exitCode = 1; });
process.once('exit', (code) => diagnostic('process_exit', { code, state, observed_at: observedAt }));
`
