import { CliError } from './errors.js'
import { mustConfirm, generateToken, verifyToken, expiresAt } from './confirm-rules.js'
import { UndoLog, type UndoEntryInput } from './undo-log.js'

export interface PreviewInfo {
  readonly side_effects: ReadonlyArray<unknown>
  readonly rollback_difficulty?: string
}

export interface RunWriteParams {
  readonly subcommand: string
  readonly args: Record<string, unknown>
  readonly command_text: string
  readonly execute: () => Promise<unknown>
  readonly reverse?: UndoEntryInput['reverse']
  readonly reverseFromResult?: (result: unknown) => UndoEntryInput['reverse']
  readonly snapshot?: unknown
  readonly collectPreview?: () => Promise<PreviewInfo>
  readonly dataDir: string
  readonly actor?: string
}

export interface OkResponse {
  readonly ok: true
  readonly action: string
  readonly result: unknown
  readonly side_effects?: ReadonlyArray<unknown>
  readonly undo?: {
    readonly id: string
    readonly expires_at: string
    readonly command: string
    readonly description: string
  }
}

export interface ConfirmRequiredResponse {
  readonly confirmation_required: true
  readonly confirmation_token: string
  readonly expires_at: string
  readonly preview: PreviewInfo & { readonly action: string }
  readonly command_to_confirm: string
}

export type RunWriteResult = OkResponse | ConfirmRequiredResponse

function actionOf(subcommand: string): string {
  const parts = subcommand.split(' ')
  return parts[parts.length - 1] ?? subcommand
}

function buildConfirmCommand(commandText: string, token: string): string {
  const stripped = commandText.replace(/\s*--confirm\s+\S+/g, '').trim()
  return `${stripped} --confirm ${token}`
}

export async function runWrite(p: RunWriteParams): Promise<RunWriteResult> {
  const requiresConfirm = mustConfirm(p.subcommand)
  const providedToken = p.args['--confirm'] as string | undefined

  if (requiresConfirm && !providedToken) {
    if (!p.collectPreview) {
      throw new CliError(
        'INTERNAL_ERROR',
        `Command '${p.subcommand}' requires confirmation but no preview collector was provided`,
      )
    }
    const preview = await p.collectPreview()
    const token = generateToken(p.subcommand, p.args)
    return {
      confirmation_required: true,
      confirmation_token: token,
      expires_at: expiresAt(),
      preview: { action: actionOf(p.subcommand), ...preview },
      command_to_confirm: buildConfirmCommand(p.command_text, token),
    }
  }

  if (requiresConfirm && providedToken) {
    const v = verifyToken(providedToken, p.subcommand, p.args)
    if (!v.valid) {
      throw new CliError(
        'CONFIRMATION_INVALID',
        `Confirmation token invalid (${v.reason})`,
        { reason: v.reason },
      )
    }
  }

  const result = await p.execute()

  const okBase: OkResponse = {
    ok: true,
    action: actionOf(p.subcommand),
    result,
  }

  // Confirm-class commands do not get written to undo log
  if (requiresConfirm) {
    return okBase
  }

  const reverse = p.reverseFromResult ? p.reverseFromResult(result) : p.reverse
  if (!reverse) return okBase

  const log = new UndoLog(p.dataDir)
  const entry = await log.append({
    original_command: p.command_text,
    reverse,
    actor: p.actor ?? 'human',
    snapshot: p.snapshot ?? null,
  })

  return {
    ...okBase,
    undo: {
      id: entry.id,
      expires_at: entry.expires_at,
      command: `crabot undo ${entry.id}`,
      description: reverse.preview_description,
    },
  }
}
