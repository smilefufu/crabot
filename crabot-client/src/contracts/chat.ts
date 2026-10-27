import { z } from 'zod'

// protocol-admin §3.20 and base-protocol §5.4/§5.10. Output keeps compatible extra fields.
export const RequestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const Id = z.string().min(1)
const ScalarText = z.string().refine(value => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false
  }
  return true
}, 'Text must be valid Unicode')
export const MediaItemSchema = z.looseObject({
  media_url: z.string(), mime_type: z.string(), filename: z.string().optional(), size: z.number().nonnegative().optional(),
})
export const ChatMessageContentSchema = z.looseObject({
  type: z.enum(['text', 'image', 'file', 'system_event']),
  text: z.string().optional(), media_url: z.string().optional(), file_path: z.string().optional(),
  filename: z.string().optional(), mime_type: z.string().optional(), size: z.number().nonnegative().optional(),
  media: z.array(MediaItemSchema).optional(), handle: z.string().optional(),
  status: z.enum(['ready', 'not_fetched', 'fetching', 'failed']).optional(),
  event_type: z.enum(['members_added', 'scheduled']).optional(),
  affected_users: z.array(z.looseObject({ platform_user_id: z.string(), platform_display_name: z.string() })).optional(),
})
export const ChatMessageSchema = z.looseObject({
  message_id: Id, role: z.enum(['user', 'assistant']), content: ChatMessageContentSchema,
  request_id: z.string().optional(), request_ids: z.array(z.string()).optional(),
  delivery_id: z.string().optional(), task_id: z.string().optional(),
  acknowledged_at: z.string().optional(), timestamp: z.string(),
})
export const TaskStatusSchema = z.enum(['queued', 'running', 'halted', 'closed'])
// Read-only v2 history compatibility; callers must never construct new tasks with these values.
export const LegacyTaskStatusSchema = z.enum(['pending', 'planning', 'executing', 'waiting_human', 'waiting_bg', 'waiting_input', 'completed', 'failed', 'cancelled'])
export const ChatTaskSnapshotSchema = z.looseObject({
  task_id: Id, status: z.union([TaskStatusSchema, LegacyTaskStatusSchema]), title: z.string(),
  step: z.looseObject({ index: z.number(), total: z.number(), description: z.string() }).optional(),
  halt: z.looseObject({
    halted_at: z.string(), halt_reason: z.string(), stop_unverified: z.boolean().optional(), detail: z.string().optional(),
    worker_self_report: z.looseObject({ outcome: z.enum(['completed', 'failed']), summary: z.string() }).optional(),
  }).optional(),
  closed: z.looseObject({ at: z.string(), by: z.string(), note: z.string().optional() }).optional(),
})
export const ChatClientMessageSchema = z.object({ type: z.literal('chat_message'), request_id: RequestIdSchema, content: ScalarText })
export const ChatInputMetadataSchema = z.object({ request_id: RequestIdSchema, text: ScalarText.optional() })
const MultipartMetadataSchema = z.object({ request_id: RequestIdSchema, text: z.string().optional(), text_json: z.string().optional() })
export function parseChatMultipartMetadata(input: unknown) {
  const parsed = MultipartMetadataSchema.safeParse(input)
  if (!parsed.success) return { success: false as const }
  const wire = parsed.data
  let text = wire.text ?? ''
  if (wire.text_json !== undefined) {
    let original: unknown
    try { original = JSON.parse(wire.text_json) } catch { return { success: false as const } }
    if (typeof original !== 'string') return { success: false as const }
    if (wire.text !== undefined && wire.text !== original && wire.text !== original.replace(/\r\n|\r|\n/g, '\r\n')) return { success: false as const }
    text = original
  }
  return ChatInputMetadataSchema.safeParse({ request_id: wire.request_id, text })
}
export const ChatHistorySchema = z.looseObject({ messages: z.array(ChatMessageSchema) })
export const ChatSendResultSchema = z.looseObject({ message: ChatMessageSchema })
export const ChatActiveTasksSchema = z.looseObject({ tasks: z.array(ChatTaskSnapshotSchema) })
export const ChatServerMessageSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('chat_reply'), request_id: z.string().optional(), request_ids: z.array(z.string()).optional(),
    content: z.string().optional(), task_id: z.string().optional(), status: z.enum(['completed', 'failed']).optional(),
    reply_type: z.enum(['direct_reply', 'task_created', 'task_completed', 'task_failed']).optional() }),
  z.looseObject({ type: z.literal('chat_error'), request_id: z.string().optional(), error: z.string() }),
  z.looseObject({ type: z.literal('chat_push'), message: ChatMessageSchema }),
  z.looseObject({ type: z.literal('chat_task_update'), task: ChatTaskSnapshotSchema }),
  z.looseObject({ type: z.literal('chat_message_tagged'), message_id: Id, task_id: Id }),
  z.looseObject({ type: z.literal('chat_message_deleted'), message_id: Id }),
  z.looseObject({ type: z.literal('chat_message_acked'), request_ids: z.array(z.string()) }),
])

export type MediaItem = z.infer<typeof MediaItemSchema>
export type ChatMessageContent = z.infer<typeof ChatMessageContentSchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ChatClientMessage = z.infer<typeof ChatClientMessageSchema>
export type ChatServerMessage = z.infer<typeof ChatServerMessageSchema>
export type ChatTaskSnapshot = z.infer<typeof ChatTaskSnapshotSchema>
