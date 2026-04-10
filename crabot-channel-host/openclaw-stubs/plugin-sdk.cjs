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
// emptyPluginConfigSchema  (from openclaw source — plugins/config-schema.ts)
// Returns a schema that accepts undefined or empty objects only.
// ---------------------------------------------------------------------------
function emptyPluginConfigSchema() {
  return {
    safeParse(value) {
      if (value === undefined) return { success: true, data: undefined }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return { success: false, error: { issues: [{ path: [], message: 'expected config object' }] } }
      if (Object.keys(value).length > 0)
        return { success: false, error: { issues: [{ path: [], message: 'config must be empty' }] } }
      return { success: true, data: value }
    },
    jsonSchema: { type: 'object', additionalProperties: false, properties: {} },
  }
}

// ---------------------------------------------------------------------------
// Constants used by channel plugins at runtime
// ---------------------------------------------------------------------------
const SILENT_REPLY_TOKEN = '<<SILENT>>'
const PAIRING_APPROVED_MESSAGE = 'Pairing approved! You can now send messages.'
const DEFAULT_GROUP_HISTORY_LIMIT = 50

// ---------------------------------------------------------------------------
// Utility functions used by channel plugins
// ---------------------------------------------------------------------------
function readStringParam(params, key, _opts) {
  if (!params || typeof params !== 'object') return undefined
  const val = params[key]
  return typeof val === 'string' ? val : undefined
}

function readNumberParam(params, key) {
  if (!params || typeof params !== 'object') return undefined
  const val = Number(params[key])
  return Number.isFinite(val) ? val : undefined
}

function readBooleanParam(params, key) {
  if (!params || typeof params !== 'object') return undefined
  const val = params[key]
  if (typeof val === 'boolean') return val
  if (val === 'true') return true
  if (val === 'false') return false
  return undefined
}

function readReactionParams(params) {
  return {
    emoji: readStringParam(params, 'emoji'),
    messageId: readStringParam(params, 'message_id') || readStringParam(params, 'messageId'),
  }
}

function buildRandomTempFilePath(opts) {
  const tmpDir = resolvePreferredOpenClawTmpDir()
  const ext = (opts && opts.extension) || ''
  const name = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext
  return path.join(tmpDir, name)
}

function formatDocsLink(pathStr, _label) {
  return 'https://docs.openclaw.com' + (pathStr || '')
}

function isNormalizedSenderAllowed(params) {
  const { senderId, allowFrom } = params || {}
  if (!allowFrom || !Array.isArray(allowFrom) || allowFrom.length === 0) return true
  if (allowFrom.includes('*')) return true
  return allowFrom.includes(senderId)
}

function addWildcardAllowFrom(allowFrom) {
  if (!allowFrom || !Array.isArray(allowFrom)) return ['*']
  if (allowFrom.includes('*')) return allowFrom
  return ['*', ...allowFrom]
}

// ---------------------------------------------------------------------------
// Message handling stubs (no-ops in shim context; Crabot handles these)
// ---------------------------------------------------------------------------
function clearHistoryEntriesIfEnabled() {}
function recordPendingHistoryEntryIfEnabled() {}
function logTypingFailure() {}
function logInboundDrop() {}
function logAckFailure() {}

function resolveThreadSessionKeys(params) {
  const chatId = params.chatId || params.threadId || 'unknown'
  return { sessionKey: chatId, historyKey: chatId }
}

function buildPendingHistoryContextFromMap() {
  return ''
}

function createReplyPrefixContext(params) {
  return { cfg: params?.cfg, agentId: params?.agentId, prefix: '' }
}

// resolveSenderCommandAuthorization — alias for the WithRuntime variant
// (plugin code calls this name; stubs had the WithRuntime suffix)
async function resolveSenderCommandAuthorization(params) {
  return resolveSenderCommandAuthorizationWithRuntime(params)
}

// ---------------------------------------------------------------------------
// Dedupe stubs — feishu plugin creates these at module top-level
// ---------------------------------------------------------------------------
// OpenClaw dedup semantics (derived from usage in feishu/dedup.ts):
//
// createDedupeCache:
//   check(key):  return TRUE = duplicate (already seen & recorded), FALSE = new (now recorded)
//   peek(key):   return TRUE = seen before, FALSE = not seen (read-only, no side effect)
//   Used as: return !cache.check(key)  → true = new message, false = duplicate
//
// createPersistentDedupe:
//   checkAndRecord(key, opts): return TRUE = new (successfully recorded), FALSE = duplicate
//   Used as: if (!(await persistent.checkAndRecord(...))) → duplicate
//   NOTE: opposite convention from cache.check()!
//
function createDedupeCache(_opts) {
  const seen = new Map()
  return {
    has(key) { return seen.has(key) },
    // check: true = duplicate, false = new (records on first call)
    check(key) {
      if (!key) return false
      if (seen.has(key)) return true
      seen.set(key, Date.now())
      return false
    },
    peek(key) { return seen.has(key) },
    checkAndRecord(key) {
      if (!key) return false
      if (seen.has(key)) return true
      seen.set(key, Date.now())
      return false
    },
    record(key) { seen.set(key, Date.now()) },
    delete(key) { seen.delete(key) },
    clear() { seen.clear() },
  }
}

function createPersistentDedupe(_opts) {
  const seen = new Map()
  return {
    // checkAndRecord: true = new (recorded), false = duplicate — opposite of cache.check()!
    checkAndRecord(key) {
      if (!key) return true
      if (seen.has(key)) return false
      seen.set(key, Date.now())
      return true
    },
    async warmup(_namespace, _onError) { /* no-op in shim */ },
  }
}

function readJsonFileWithFallback(_filePath, fallback) {
  return fallback
}

// ---------------------------------------------------------------------------
// createScopedPairingAccess — shim always allows all senders (pairing disabled)
// ---------------------------------------------------------------------------
function createScopedPairingAccess() {
  return {
    readAllowFromStore: async () => ['*'],
    writeAllowToStore: async () => {},
    clearStore: async () => {},
  }
}

// ---------------------------------------------------------------------------
// buildAgentMediaPayload — converts media list to MsgContext media fields
// ---------------------------------------------------------------------------
function buildAgentMediaPayload(mediaList) {
  if (!mediaList || mediaList.length === 0) return {}
  const first = mediaList[0]
  const result = {
    MediaPath: first.path,
    MediaType: first.contentType,
    MediaUrl: first.path,
  }
  if (mediaList.length > 1) {
    const paths = mediaList.map(function (m) { return m.path })
    result.MediaPaths = paths
    result.MediaTypes = mediaList.map(function (m) { return m.contentType })
    result.MediaUrls = paths
  }
  return result
}

// ---------------------------------------------------------------------------
// Exports — wrapped in Proxy to prevent crashes on unknown SDK exports.
// Known functions return real implementations; unknown ones log a warning
// and return undefined (for constants) or a no-op function (if called).
// ---------------------------------------------------------------------------
const _exports = {
  buildChannelConfigSchema,
  emptyPluginConfigSchema,
  createDedupeCache,
  createPersistentDedupe,
  readJsonFileWithFallback,
  resolvePreferredOpenClawTmpDir,
  normalizeAccountId,
  DEFAULT_ACCOUNT_ID,
  SILENT_REPLY_TOKEN,
  PAIRING_APPROVED_MESSAGE,
  DEFAULT_GROUP_HISTORY_LIMIT,
  stripMarkdown,
  withFileLock,
  createTypingCallbacks,
  resolveDirectDmAuthorizationOutcome,
  resolveSenderCommandAuthorization,
  resolveSenderCommandAuthorizationWithRuntime,
  createPluginRuntimeStore,
  readStringParam,
  readNumberParam,
  readBooleanParam,
  readReactionParams,
  buildRandomTempFilePath,
  formatDocsLink,
  isNormalizedSenderAllowed,
  addWildcardAllowFrom,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
  logTypingFailure,
  logInboundDrop,
  logAckFailure,
  resolveThreadSessionKeys,
  buildPendingHistoryContextFromMap,
  createReplyPrefixContext,
  buildAgentMediaPayload,
  createScopedPairingAccess,
}

const _warned = new Set()
const _proxy = new Proxy(_exports, {
  get(target, prop) {
    if (prop in target) return target[prop]
    if (typeof prop === 'symbol') return undefined
    // jiti interopDefault accesses .default — return the proxy itself so named exports survive
    if (prop === 'default') return _proxy
    if (prop === '__esModule') return true
    if (!_warned.has(prop)) {
      _warned.add(prop)
      console.warn('[openclaw-stub] unknown export accessed:', prop)
    }
    // Return a no-op function that returns an empty object as safety net.
    // Callers may destructure the result (e.g. createDefaultChannelRuntimeState),
    // so {} is safer than undefined. Also serves as a truthy value for constant checks.
    return function _stubbed() { return {} }
  },
})
module.exports = _proxy
