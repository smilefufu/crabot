import { z } from 'crabot-client'
export const InstallationProgressSchema = z.object({
  message: z.string().min(1).max(512), cancellable: z.boolean(),
}).strict()
export type InstallationProgress = z.infer<typeof InstallationProgressSchema>
