/**
 * runtime/stubs.ts - 所有其他 runtime 函数的安全 stub
 *
 * OpenClaw 插件调用 runtime 上的各种方法，这里提供安全的默认实现，
 * 防止插件因找不到方法而崩溃。
 *
 * text.* stubs 对应 PluginRuntimeChannel.text（feishu 等插件实际调用）：
 *   - chunkTextWithMode / chunkText 等：返回 [text]（不拆分，发整条）
 *   - resolveTextChunkLimit：返回 4000
 *   - resolveChunkMode：返回 'default'
 *   - resolveMarkdownTableMode：返回 'off'（不转换表格）
 *   - convertMarkdownTables：原样返回
 */

export const runtimeStubs = {
  // ── text ──────────────────────────────────────────────────────────────────
  text: {
    // 文本分块（stub：不拆分，发整条）
    chunkText: (text: string): string[] => [text],
    chunkTextWithMode: (text: string, _limit?: unknown, _mode?: unknown): string[] => [text],
    chunkByNewline: (text: string, _limit?: unknown): string[] => [text],
    chunkMarkdownText: (text: string, _limit?: unknown): string[] => [text],
    chunkMarkdownTextWithMode: (text: string, _limit?: unknown, _mode?: unknown): string[] => [text],

    // 配置解析（stub：返回合理默认值）
    resolveTextChunkLimit: (_cfg?: unknown, _channel?: unknown, _accountId?: unknown, opts?: { fallbackLimit?: number }): number =>
      (opts as { fallbackLimit?: number } | undefined)?.fallbackLimit ?? 4000,
    resolveChunkMode: (_cfg?: unknown, _channel?: unknown): string => 'default',
    resolveMarkdownTableMode: (_opts?: unknown): string => 'off',
    resolveEnvelopeFormatOptions: (_opts?: unknown): Record<string, unknown> => ({}),

    // 检测命令（stub：没有命令）
    detectCommand: (): null => null,
    hasControlCommand: (): boolean => false,

    // Markdown 表格（stub：原样返回）
    convertMarkdownTables: (text: string, _mode?: unknown): string => text,
  },

  // ── session ────────────────────────────────────────────────────────────────
  session: {
    getOrCreate: (key: string) => ({ key }),
    resolveStorePath: (_opts?: unknown): string => '',
    readSessionUpdatedAt: (_opts?: unknown): number | null => null,
    recordSessionMetaFromInbound: async (_opts?: unknown): Promise<void> => {},
    recordInboundSession: async (_opts?: unknown): Promise<void> => {},
    updateLastRoute: async (_opts?: unknown): Promise<void> => {},
  },

  // ── pairing ────────────────────────────────────────────────────────────────
  // Phase 1: 自动通过所有用户,不做真实的配对审核
  // TODO Phase 2: 实现真实的配对请求存储和审核机制(数据库 + Web UI)
  pairing: {
    getOrCreate: (): null => null,
    buildPairingReply: (): null => null,
    // 返回通配符,让所有用户都在"白名单"中
    readAllowFromStore: async (): Promise<string[]> => ['*'],
    // 生成假配对码,标记为未创建(不发送配对消息)
    upsertPairingRequest: async (): Promise<{ code: string; created: boolean }> => ({
      code: 'STUB-PAIR-CODE',
      created: false,
    }),
  },

  // ── debounce ───────────────────────────────────────────────────────────────
  debounce: {
    wrap: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
    createInboundDebouncer: (opts?: { onFlush?: (entries: unknown[]) => Promise<void> }) => ({
      // 不做防抖，收到消息立即 flush
      enqueue: async (entry: unknown) => { await opts?.onFlush?.([entry]) },
      flush: async () => {},
    }),
    resolveInboundDebounceMs: (): number => 0,
  },

  // ── media ──────────────────────────────────────────────────────────────────
  media: {
    resolveMedia: (): null => null,
    fetchRemoteMedia: async (): Promise<null> => null,
    saveMediaBuffer: async (): Promise<null> => null,
  },

  // ── activity ───────────────────────────────────────────────────────────────
  activity: {
    track: (): void => undefined,
    record: async (): Promise<void> => {},
    get: async (): Promise<null> => null,
  },

  // ── mentions ───────────────────────────────────────────────────────────────
  mentions: {
    resolve: (): unknown[] => [],
    buildMentionRegexes: (): unknown[] => [],
    matchesMentionPatterns: (): boolean => false,
    matchesMentionWithExplicit: (): boolean => false,
  },

  // ── reactions ──────────────────────────────────────────────────────────────
  reactions: {
    shouldAckReaction: (): boolean => false,
    removeAckReactionAfterReply: async (): Promise<void> => {},
  },

  // ── groups ─────────────────────────────────────────────────────────────────
  groups: {
    resolveGroupPolicy: (): string => 'none',
    resolveRequireMention: (): boolean => false,
  },

  // ── commands ───────────────────────────────────────────────────────────────
  commands: {
    resolveCommandAuthorizedFromAuthorizers: (): boolean => false,
    isControlCommandMessage: (): boolean => false,
    shouldComputeCommandAuthorized: (): boolean => false,
    shouldHandleTextCommands: (): boolean => false,
  },

  // ── subagent ───────────────────────────────────────────────────────────────
  subagent: {
    run: (): Promise<never> =>
      Promise.reject(new Error('subagent not implemented in Phase 1')),
  },

  // ── 平台特定 stub（防止插件访问不存在的平台功能时崩溃） ──────────────────
  telegram: {
    sendAction: (): Promise<void> => Promise.resolve(),
    pinMessage: (): Promise<void> => Promise.resolve(),
    monitorTelegramProvider: (): Promise<void> => Promise.resolve(),
    probeTelegram: async (): Promise<null> => null,
    resolveTelegramToken: (): null => null,
    sendMessageTelegram: async (): Promise<null> => null,
    sendPollTelegram: async (): Promise<null> => null,
    messageActions: null,
  },
  discord: {
    createThread: (): Promise<null> => Promise.resolve(null),
    addReaction: (): Promise<void> => Promise.resolve(),
    monitorDiscordProvider: (): Promise<void> => Promise.resolve(),
    probeDiscord: async (): Promise<null> => null,
    sendMessageDiscord: async (): Promise<null> => null,
    messageActions: null,
  },
  slack: {
    addReaction: (): Promise<void> => Promise.resolve(),
    updateMessage: (): Promise<void> => Promise.resolve(),
    monitorSlackProvider: (): Promise<void> => Promise.resolve(),
    probeSlack: async (): Promise<null> => null,
    sendMessageSlack: async (): Promise<null> => null,
    messageActions: null,
  },
  signal: {
    probeSignal: async (): Promise<null> => null,
    sendMessageSignal: async (): Promise<null> => null,
    monitorSignalProvider: (): Promise<void> => Promise.resolve(),
    messageActions: null,
  },
  imessage: {
    probeIMessage: async (): Promise<null> => null,
    sendMessageIMessage: async (): Promise<null> => null,
    monitorIMessageProvider: (): Promise<void> => Promise.resolve(),
  },
  whatsapp: {
    sendMessageWhatsApp: async (): Promise<null> => null,
    loginWeb: async (): Promise<null> => null,
    monitorWebChannel: (): Promise<void> => Promise.resolve(),
    webAuthExists: (): boolean => false,
    messageActions: null,
  },
  line: {
    probeLineBot: async (): Promise<null> => null,
    sendMessageLine: async (): Promise<null> => null,
    monitorLineProvider: (): Promise<void> => Promise.resolve(),
    pushMessageLine: async (): Promise<null> => null,
  },
}
