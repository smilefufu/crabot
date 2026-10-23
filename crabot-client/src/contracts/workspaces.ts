import { z } from 'zod'

// Canonical fields and invariants: protocol-workspaces §2–§3.
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const WorkspaceIdSchema = z.union([z.literal('default'), z.uuid()])
const Name = z.string().min(1).max(120).refine(value => value === value.trim() && !value.includes('\0'))
const Description = z.string().max(2000).refine(value => value === value.trim() && !value.includes('\0'))
const Directory = z.string().min(1).refine(value => !value.includes('\0') && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value))
export const WorkspaceRecordSchema = z.object({
  workspace_id: WorkspaceIdSchema, kind: z.enum(['project', 'default']), name: Name, description: Description,
  root: Directory, source: z.enum(['managed', 'existing']), created_at: z.iso.datetime(), last_used_at: z.iso.datetime().optional(),
}).refine(value => (value.workspace_id === 'default') === (value.kind === 'default'))
export const WorkspaceUsageSchema = z.object({
  status: z.enum(['pending', 'measuring', 'complete', 'partial', 'failed', 'stale']),
  measured_at: z.iso.datetime().optional(), logical_bytes: Count.optional(), allocated_bytes: Count.optional(),
  file_count: Count, skipped_entries: Count,
})
export const WorkspaceExecutionSchema = z.object({
  status: z.enum(['running', 'idle', 'unknown']), observed_at: z.iso.datetime().optional(), worker_count: Count.optional(), running_worker_count: Count.optional(),
})
export const WorkspaceExecutionInventorySchema = z.object({ ready: z.boolean(), items: z.record(WorkspaceIdSchema, WorkspaceExecutionSchema) })
export const WorkspaceSummarySchema = z.object({
  workspace: WorkspaceRecordSchema, directory_status: z.enum(['ready', 'missing', 'unavailable']),
  usage: WorkspaceUsageSchema, execution: WorkspaceExecutionSchema,
})
export const WorkspaceMaintenanceStatusSchema = z.object({ maintenance: z.boolean() })
export const WorkspaceListResultSchema = z.object({ revision: Count, storage_root: Directory, items: z.array(WorkspaceSummarySchema) })
export const WorkspaceCreateRequestSchema = z.strictObject({
  workspace_id: z.uuid(), name: z.string().trim().pipe(Name), description: z.string().trim().pipe(Description).optional(), root: Directory.optional(),
})
export const WorkspaceUpdateRequestSchema = z.strictObject({
  expected_revision: Count.min(1), name: z.string().trim().pipe(Name), description: z.string().trim().pipe(Description),
})
export const WorkspaceRecordResultSchema = z.object({ revision: Count, workspace: WorkspaceRecordSchema })
export const WorkspaceGetResultSchema = z.object({ revision: Count, item: WorkspaceSummarySchema })
export const WorkspaceScanResultSchema = z.object({ workspace_id: WorkspaceIdSchema, usage: WorkspaceUsageSchema })
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>
export type WorkspaceUsage = z.infer<typeof WorkspaceUsageSchema>
export type WorkspaceExecution = z.infer<typeof WorkspaceExecutionSchema>
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>
export type WorkspaceListResult = z.infer<typeof WorkspaceListResultSchema>
export type WorkspaceCreateRequest = z.infer<typeof WorkspaceCreateRequestSchema>
export type WorkspaceUpdateRequest = z.infer<typeof WorkspaceUpdateRequestSchema>
export type WorkspaceRecordResult = z.infer<typeof WorkspaceRecordResultSchema>
export type WorkspaceGetResult = z.infer<typeof WorkspaceGetResultSchema>
export type WorkspaceScanResult = z.infer<typeof WorkspaceScanResultSchema>

export type WorkspaceExecutionInventory = z.infer<typeof WorkspaceExecutionInventorySchema>

export type WorkspaceMaintenanceStatus = z.infer<typeof WorkspaceMaintenanceStatusSchema>


export const WorkspaceRelocationPreviewRequestSchema = z.strictObject({ target: Directory })
export const WorkspaceRelocationIssueSchema = z.object({ path: z.string(), reason: z.enum(['absolute_link', 'external_link', 'git_worktree', 'python_environment', 'external_hardlink', 'mount_point', 'special_file', 'unreadable']) })
export const WorkspaceRelocationPreviewResultSchema = z.object({
  revision: Count.min(1), source: Directory, target: Directory, mode: z.enum(['unchanged', 'rename', 'copy']),
  workspaces: z.array(WorkspaceRecordSchema), retained_workspaces: z.array(WorkspaceRecordSchema),
  usage: WorkspaceUsageSchema.optional(), available_bytes: z.string().regex(/^(?:0|[1-9][0-9]*)$/).optional(),
  issues: z.array(WorkspaceRelocationIssueSchema), execution: WorkspaceExecutionInventorySchema,
}).refine(value => value.mode === 'unchanged' ? value.source === value.target
  : value.source !== value.target && value.usage !== undefined && value.available_bytes !== undefined)
export type WorkspaceRelocationPreviewRequest = z.infer<typeof WorkspaceRelocationPreviewRequestSchema>
export type WorkspaceRelocationPreviewResult = z.infer<typeof WorkspaceRelocationPreviewResultSchema>
export type WorkspaceRelocationIssue = z.infer<typeof WorkspaceRelocationIssueSchema>
