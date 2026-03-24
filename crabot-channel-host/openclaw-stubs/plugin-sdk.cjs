/**
 * Lightweight stub for openclaw/plugin-sdk.
 *
 * Provides the subset of runtime exports that OpenClaw channel plugins
 * actually import. Used when the full `openclaw` package is not installed
 * (e.g. deployment environments that only need the shim).
 *
 * Each function mirrors the real implementation's contract; complex internals
 * (event loops, OS-level file locks) are simplified to no-ops where the shim
 * context doesn't require them.
 */

'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

// ---------------------------------------------------------------------------
// buildChannelConfigSchema  (verbatim from openclaw source)
// ---------------------------------------------------------------------------
function buildChannelConfigSchema(schema) {
  const s = schema
  if (typeof s?.toJSONSchema === 'function') {
    return { schema: s.toJSONSchema({ target: 'draft-07', unrepresentable: 'any' }) }
  }
  return { schema: { type: 'object', additionalProperties: true } }
}

// ---------------------------------------------------------------------------
// resolvePreferredOpenClawTmpDir  (simplified: just os.tmpdir()/openclaw-<uid>)
// ---------------------------------------------------------------------------
function resolvePreferredOpenClawTmpDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const suffix = uid === undefined ? 'openclaw' : `openclaw-${uid}`
  const dir = path.join(os.tmpdir(), suffix)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// normalizeAccountId  (verbatim logic from openclaw source)
// ---------------------------------------------------------------------------
const DEFAULT_ACCOUNT_ID = 'default'
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g
const LEADING_DASH_RE = /^-+/
const TRAILING_DASH_RE = /-+$/
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'])

function normalizeAccountId(value) {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return DEFAULT_ACCOUNT_ID
  let canonical
  if (VALID_ID_RE.test(trimmed)) {
    canonical = trimmed.toLowerCase()
  } else {
    canonical = trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, '-')
      .replace(LEADING_DASH_RE, '')
      .replace(TRAILING_DASH_RE, '')
      .slice(0, 64)
  }
  if (!canonical || BLOCKED_KEYS.has(canonical)) return DEFAULT_ACCOUNT_ID
  return canonical
}

// ---------------------------------------------------------------------------
// stripMarkdown  (verbatim from openclaw source)
// ---------------------------------------------------------------------------
function stripMarkdown(text) {
  let result = text
  result = result.replace(/\*\*(.+?)\*\*/g, '$1')
  result = result.replace(/__(.+?)__/g, '$1')
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')
  result = result.replace(/~~(.+?)~~/g, '$1')
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '$1')
  result = result.replace(/^>\s?(.*)$/gm, '$1')
  result = result.replace(/^[-*_]{3,}$/gm, '')
  result = result.replace(/`([^`]+)`/g, '$1')
  result = result.replace(/\n{3,}/g, '\n\n')
  result = result.trim()
  return result
}

// ---------------------------------------------------------------------------
// withFileLock  (simplified: execute fn directly, no OS-level locking)
// ---------------------------------------------------------------------------
async function withFileLock(_filePath, _fallback, fn) {
  return await fn()
}

// ---------------------------------------------------------------------------
// createTypingCallbacks  (simplified: fire start/stop, skip keepalive loop)
// ---------------------------------------------------------------------------
function createTypingCallbacks(params) {
  let closed = false
  const fireStop = () => {
    if (closed) return
    closed = true
    if (params.stop) {
      params.stop().catch((err) => {
        const handler = params.onStopError ?? params.onStartError
        if (handler) handler(err)
      })
    }
  }
  return {
    onReplyStart: async () => {
      if (closed) return
      try { await params.start() } catch (err) {
        if (params.onStartError) params.onStartError(err)
      }
    },
    onIdle: fireStop,
    onCleanup: fireStop,
  }
}

// ---------------------------------------------------------------------------
// resolveDirectDmAuthorizationOutcome  (verbatim from openclaw source)
// ---------------------------------------------------------------------------
function resolveDirectDmAuthorizationOutcome(params) {
  if (params.isGroup) return 'allowed'
  if (params.dmPolicy === 'disabled') return 'disabled'
  if (params.dmPolicy !== 'open' && !params.senderAllowedForCommands) return 'unauthorized'
  return 'allowed'
}

// ---------------------------------------------------------------------------
// resolveSenderCommandAuthorizationWithRuntime
// In Crabot shim context, Admin handles authorization — plugin-level auth
// must be a pass-through. The caller destructures { senderAllowedForCommands,
// commandAuthorized } so we MUST return those fields (not just { authorized }).
// ---------------------------------------------------------------------------
async function resolveSenderCommandAuthorizationWithRuntime(params) {
  // Read the allow-from store (pairing list) if provided
  const storeAllowFrom = params.readAllowFromStore
    ? await params.readAllowFromStore().catch(() => [])
    : []
  const effectiveAllowFrom = [...(params.configuredAllowFrom || []), ...storeAllowFrom]

  // Determine if sender is allowed: empty list = open, '*' = wildcard, or exact match
  let senderAllowedForCommands = true
  if (effectiveAllowFrom.length > 0 && params.isSenderAllowed) {
    senderAllowedForCommands =
      effectiveAllowFrom.includes('*') ||
      params.isSenderAllowed(params.senderId, effectiveAllowFrom)
  }

  return {
    senderAllowedForCommands,
    commandAuthorized: undefined,
    effectiveAllowFrom,
    effectiveGroupAllowFrom: params.configuredGroupAllowFrom || [],
    shouldComputeAuth: false,
  }
}

// ---------------------------------------------------------------------------
// createPluginRuntimeStore  (utility used by some plugins)
// ---------------------------------------------------------------------------
function createPluginRuntimeStore(errorMessage) {
  let runtime = null
  return {
    setRuntime(next) { runtime = next },
    clearRuntime() { runtime = null },
    getRuntime() {
      if (!runtime) throw new Error(errorMessage || 'Runtime not available')
      return runtime
    },
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  buildChannelConfigSchema,
  resolvePreferredOpenClawTmpDir,
  normalizeAccountId,
  DEFAULT_ACCOUNT_ID,
  stripMarkdown,
  withFileLock,
  createTypingCallbacks,
  resolveDirectDmAuthorizationOutcome,
  resolveSenderCommandAuthorizationWithRuntime,
  createPluginRuntimeStore,
}
