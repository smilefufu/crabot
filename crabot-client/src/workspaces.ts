import { z } from 'zod'
import type { HttpClient, RequestOptions } from './http.js'
import { WorkspaceCreateRequestSchema, WorkspaceGetResultSchema, WorkspaceIdSchema, WorkspaceListResultSchema,
  WorkspaceRecordResultSchema, WorkspaceScanResultSchema, WorkspaceMaintenanceStatusSchema, WorkspaceUpdateRequestSchema, WorkspaceUsageSchema,
  WorkspaceRelocationPreviewRequestSchema, WorkspaceRelocationPreviewResultSchema, VerifyWorkspaceRelocationStartParamsSchema, WorkspaceRelocationStartResultSchema, WorkspaceRelocationJobQuerySchema, WorkspaceRelocationStatusResultSchema,
  StartWorkspaceRelocationRecoveryParamsSchema, WorkspaceRelocationRecoveryPreviewResultSchema, WorkspaceRelocationRecoveryAcceptedSchema, type StartWorkspaceRelocationRecoveryParams,
  type VerifyWorkspaceRelocationStartParams, type WorkspaceRelocationPreviewRequest, type WorkspaceCreateRequest, type WorkspaceUpdateRequest } from './contracts/workspaces.js'

export class WorkspaceClient {
  constructor(private readonly http: HttpClient) {}
  maintenance(options?: RequestOptions) { return this.http.request('/workspaces/maintenance', WorkspaceMaintenanceStatusSchema, { ...options, method: 'GET' }) }
  previewRelocation(input: WorkspaceRelocationPreviewRequest, options?: RequestOptions) {
    return this.write('/workspaces/relocation/preview', 'POST', WorkspaceRelocationPreviewRequestSchema.parse(input), WorkspaceRelocationPreviewResultSchema, { timeoutMs: 120_000, ...options })
  }
  currentRelocation(options?: RequestOptions) { return this.http.request('/workspaces/relocation/current', WorkspaceRelocationStatusResultSchema, { ...options, method: 'GET' }) }
  relocationStatus(id: string, options?: RequestOptions) {
    const query = WorkspaceRelocationJobQuerySchema.required().parse({ intent_id: id })
    const response = WorkspaceRelocationStatusResultSchema.refine(value => !value.job || value.job.intent_id === query.intent_id)
    return this.http.request('/workspaces/relocation/jobs/' + encodeURIComponent(query.intent_id), response, { ...options, method: 'GET' })
  }
  previewRelocationRecovery(id: string, options?: RequestOptions) {
    const query = WorkspaceRelocationJobQuerySchema.required().parse({ intent_id: id })
    const response = WorkspaceRelocationRecoveryPreviewResultSchema.refine(value => !value.recovery || value.recovery.intent_id === query.intent_id)
    return this.http.request('/workspaces/relocation/jobs/' + encodeURIComponent(query.intent_id) + '/recovery', response, { ...options, method: 'GET' })
  }
  startRelocationRecovery(input: StartWorkspaceRelocationRecoveryParams, options?: RequestOptions) {
    const request = StartWorkspaceRelocationRecoveryParamsSchema.parse(input)
    const response = WorkspaceRelocationRecoveryAcceptedSchema.refine(value => value.intent_id === request.intent_id && value.recovery_id === request.recovery_id)
    return this.write('/workspaces/relocation/recover', 'POST', request, response, { timeoutMs: 120_000, ...options })
  }
  startRelocation(input: VerifyWorkspaceRelocationStartParams, options?: RequestOptions) {
    const request = VerifyWorkspaceRelocationStartParamsSchema.parse(input)
    const receipt = WorkspaceRelocationStartResultSchema.refine(value => !('accepted' in value) || value.intent_id === request.intent_id)
    return this.write('/workspaces/relocation/start', 'POST', request, receipt, { timeoutMs: 120_000, ...options })
  }
  list(options?: RequestOptions) { return this.http.request('/workspaces', WorkspaceListResultSchema, { ...options, method: 'GET' }) }
  get(id: string, options?: RequestOptions) { return this.http.request(this.path(id), WorkspaceGetResultSchema, { ...options, method: 'GET' }) }
  create(input: WorkspaceCreateRequest, options?: RequestOptions) {
    return this.write('/workspaces', 'POST', WorkspaceCreateRequestSchema.parse(input), WorkspaceRecordResultSchema, options)
  }
  update(id: string, input: WorkspaceUpdateRequest, options?: RequestOptions) {
    return this.write(this.path(id), 'PATCH', WorkspaceUpdateRequestSchema.parse(input), WorkspaceRecordResultSchema, options)
  }
  usage(id: string, options?: RequestOptions) { return this.http.request(this.path(id) + '/usage', WorkspaceScanResultSchema, { ...options, method: 'GET' }) }
  refresh(id: string, options?: RequestOptions) { return this.write(this.path(id) + '/usage/refresh', 'POST', {}, WorkspaceScanResultSchema, options) }
  totalUsage(options?: RequestOptions) { return this.http.request('/workspaces/usage', WorkspaceUsageSchema, { ...options, method: 'GET' }) }
  refreshTotalUsage(options?: RequestOptions) { return this.write('/workspaces/usage/refresh', 'POST', {}, WorkspaceUsageSchema, options) }
  private path(id: string) { return '/workspaces/' + encodeURIComponent(WorkspaceIdSchema.parse(id)) }
  private write<T>(path: string, method: string, input: unknown, schema: z.ZodType<T>, options?: RequestOptions) {
    const headers = new Headers(options?.headers); headers.set('Content-Type', 'application/json')
    return this.http.request(path, schema, { ...options, method, headers, body: JSON.stringify(input) })
  }
}
