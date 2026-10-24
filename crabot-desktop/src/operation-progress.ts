import { z } from 'crabot-client'
export const OperationProgressSchema = z.object({
  message: z.string().min(1).max(512), cancellable: z.boolean(),
}).strict()
export type OperationProgress = z.infer<typeof OperationProgressSchema>
