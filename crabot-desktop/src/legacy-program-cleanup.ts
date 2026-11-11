import type { dialog as ElectronDialog } from 'electron'
interface Preview { relative: string; bytes: number }
interface Retained { relative: string; reason: string }
interface Cleanup { preview: Preview[]; retained: Retained[]; removeConfirmed(): Promise<{ removed: string[]; retained: Retained[] }> }
/** Main-process human confirmation; the renderer cannot supply deletion paths. */
export async function showLegacyProgramCleanup(root: string, dialog: Pick<typeof ElectronDialog, 'showMessageBox'>,
  load = async () => import(new URL('./bootstrap/scripts/lib/desktop-legacy-cleanup.mjs', import.meta.url).href) as Promise<{ legacyProgramCleanup(root: string): Promise<Cleanup> }>): Promise<void> {
  try {
    const cleanup = await (await load()).legacyProgramCleanup(root)
    const list = (items: Retained[]) => items.map(item => `${item.relative}：${item.reason}`).join('\n')
    if (!cleanup.preview.length) {
      await dialog.showMessageBox({ type: 'info', title: '清理旧程序', message: '没有可确认安全清理的旧程序目录。', detail: list(cleanup.retained), buttons: ['关闭'] })
      return
    }
    const bytes = cleanup.preview.reduce((sum, item) => sum + item.bytes, 0)
    const answer = await dialog.showMessageBox({ type: 'question', title: '清理旧程序', message: `清理以下旧程序，约 ${(bytes / 1024 / 1024).toFixed(1)} MiB？`,
      detail: cleanup.preview.map(item => `${item.relative}（${(item.bytes / 1024 / 1024).toFixed(1)} MiB）`).join('\n')
        + '\n\n当前程序、用户数据、工作区及正在使用的运行环境保留。'
        + (cleanup.retained.length ? '\n\n保留：\n' + list(cleanup.retained) : ''), buttons: ['取消', '清理列出的旧程序'], defaultId: 0, cancelId: 0 })
    if (answer.response !== 1) return
    const result = await cleanup.removeConfirmed()
    await dialog.showMessageBox({ type: 'info', title: '旧程序清理结果', message: `已清理 ${result.removed.length} 个旧程序目录。`,
      detail: result.retained.length ? '以下目录未清理完成或已保留：\n' + list(result.retained) : '用户数据和工作区未改动。', buttons: ['关闭'] })
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', title: '旧程序清理未完成', message: error instanceof Error ? error.message : String(error), buttons: ['关闭'] })
  }
}
