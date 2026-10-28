// Only the current GUI's exit after its selected target has been verified.
// Data startup and health remain owned by target maintenance recovery.
import type { App } from 'electron'

export async function handoffDesktopPair(options: {
  target: { executable: string; dataDir: string }
  verify: (target: { executable: string; dataDir: string }) => Promise<void>
  app: Pick<App, 'relaunch' | 'quit' | 'once' | 'off'>
  beginExit: () => () => void
}): Promise<void> {
  await options.verify(options.target)
  const undo = options.beginExit()
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); options.app.off('quit', completed) }
      const completed = () => { cleanup(); resolve() }
      const timer = setTimeout(() => {
        cleanup(); reject(Object.assign(new Error('GUI exit remains unconfirmed'), { code: 'CRABOT_DESKTOP_HANDOFF' }))
      }, 180_000)
      options.app.once('quit', completed)
      try { options.app.relaunch({ execPath: options.target.executable, args: [] }); options.app.quit() }
      catch (error) { cleanup(); reject(error) }
    })
  } catch (error) { undo(); throw error }
}
