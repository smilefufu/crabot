/**
 * Computer Use MCP Server — macOS computer interaction
 *
 * Provides 4 tools: screenshot, mouse_click, keyboard_type, keyboard_key
 * Uses screencapture and AppleScript (osascript) for macOS.
 */

import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import { execFile } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ============================================================================
// Helpers
// ============================================================================

function execFilePromise(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string })
      }
    })
  })
}

/**
 * Map of named keys to macOS key codes.
 * @see https://eastmanreference.com/complete-list-of-applescript-key-codes
 */
const KEY_CODE_MAP: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  escape: 53,
  delete: 51,
  forwarddelete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
}

function buildKeyPressScript(key: string, modifiers?: string[]): string {
  const keyCode = KEY_CODE_MAP[key.toLowerCase()]
  const modifierClause = modifiers && modifiers.length > 0
    ? ` using {${modifiers.map(m => `${m} down`).join(', ')}}`
    : ''

  if (keyCode !== undefined) {
    return `tell application "System Events" to key code ${keyCode}${modifierClause}`
  }

  // For single character keys, use keystroke
  if (key.length === 1) {
    return `tell application "System Events" to keystroke "${key}"${modifierClause}`
  }

  // Fallback: try as key code number
  return `tell application "System Events" to key code ${key}${modifierClause}`
}

// ============================================================================
// MCP Server
// ============================================================================

export function createComputerUseServer(): McpServer {
  const server = createMcpServer({ name: 'computer-use', version: '1.0.0' })

  // ================================================================
  // 1. screenshot — capture screen as PNG
  // ================================================================
  server.tool(
    'screenshot',
    'Capture a screenshot of the screen. Returns the image as base64 PNG.',
    {
      display: z.number().optional().describe('Display index (default 0, the main display)'),
    },
    async (args) => {
      const tmpPath = join(tmpdir(), `crabot-screenshot-${Date.now()}.png`)

      try {
        const captureArgs = ['-x', '-t', 'png']
        if (args.display !== undefined && args.display !== 0) {
          captureArgs.push('-D', String(args.display))
        }
        captureArgs.push(tmpPath)

        await execFilePromise('screencapture', captureArgs)

        const imageBuffer = readFileSync(tmpPath)
        const base64Data = imageBuffer.toString('base64')

        return {
          content: [{
            type: 'image' as const,
            mimeType: 'image/png',
            data: base64Data,
          }],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Screenshot failed: ${msg}` }],
        }
      } finally {
        try {
          unlinkSync(tmpPath)
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  )

  // ================================================================
  // 2. mouse_click — click at coordinates
  // ================================================================
  server.tool(
    'mouse_click',
    'Move the mouse to (x, y) and click. Supports left/right click and double click.',
    {
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      button: z.enum(['left', 'right']).optional().describe('Mouse button (default left)'),
      double_click: z.boolean().optional().describe('Whether to double-click (default false)'),
    },
    async (args) => {
      const { x, y } = args
      const button = args.button ?? 'left'
      const isDouble = args.double_click ?? false

      // Build AppleScript for mouse click
      // Using System Events with Cocoa scripting
      const clickAction = button === 'right'
        ? (isDouble ? 'double right click' : 'right click')
        : (isDouble ? 'double click' : 'click')

      const script = `
tell application "System Events"
  set mousePosition to {${x}, ${y}}
  do shell script "cliclick m:${x},${y}"
  delay 0.05
  do shell script "cliclick ${button === 'right' ? 'rc' : (isDouble ? 'dc' : 'c')}:${x},${y}"
end tell
`
      // Fallback: pure AppleScript using CGEvent
      const fallbackScript = `
use framework "CoreGraphics"
set pointRef to current application's CGPointMake(${x}, ${y})
set moveEvent to current application's CGEventCreateMouseEvent(missing value, current application's kCGEventMouseMoved, pointRef, 0)
current application's CGEventPost(current application's kCGHIDEventTap, moveEvent)
delay 0.05
set ${button === 'right' ? 'rightDown' : 'downEvent'} to current application's CGEventCreateMouseEvent(missing value, current application's ${button === 'right' ? 'kCGEventRightMouseDown' : 'kCGEventLeftMouseDown'}, pointRef, 0)
set ${button === 'right' ? 'rightUp' : 'upEvent'} to current application's CGEventCreateMouseEvent(missing value, current application's ${button === 'right' ? 'kCGEventRightMouseUp' : 'kCGEventLeftMouseUp'}, pointRef, 0)
current application's CGEventPost(current application's kCGHIDEventTap, ${button === 'right' ? 'rightDown' : 'downEvent'})
current application's CGEventPost(current application's kCGHIDEventTap, ${button === 'right' ? 'rightUp' : 'upEvent'})
${isDouble ? `delay 0.05
current application's CGEventPost(current application's kCGHIDEventTap, ${button === 'right' ? 'rightDown' : 'downEvent'})
current application's CGEventPost(current application's kCGHIDEventTap, ${button === 'right' ? 'rightUp' : 'upEvent'})` : ''}
`

      try {
        // Try cliclick first, fall back to pure AppleScript
        try {
          await execFilePromise('osascript', ['-e', script])
        } catch {
          await execFilePromise('osascript', ['-e', fallbackScript])
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, action: clickAction, x, y }),
          }],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Mouse click failed: ${msg}` }) }],
        }
      }
    },
  )

  // ================================================================
  // 3. keyboard_type — type text
  // ================================================================
  server.tool(
    'keyboard_type',
    'Type text using the keyboard. Simulates keystrokes for each character.',
    {
      text: z.string().describe('The text to type'),
    },
    async (args) => {
      // Escape backslashes and double quotes for AppleScript string
      const escaped = args.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const script = `tell application "System Events" to keystroke "${escaped}"`

      try {
        await execFilePromise('osascript', ['-e', script])

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, typed: args.text }),
          }],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Keyboard type failed: ${msg}` }) }],
        }
      }
    },
  )

  // ================================================================
  // 4. keyboard_key — press a key with optional modifiers
  // ================================================================
  server.tool(
    'keyboard_key',
    'Press a keyboard key with optional modifiers (command, shift, control, option).',
    {
      key: z.string().describe('Key name (return, tab, escape, space, delete, up, down, left, right, f1-f12) or single character'),
      modifiers: z.array(z.string()).optional().describe('Modifier keys: command, shift, control, option'),
    },
    async (args) => {
      const script = buildKeyPressScript(args.key, args.modifiers)

      try {
        await execFilePromise('osascript', ['-e', script])

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, key: args.key, modifiers: args.modifiers }),
          }],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Key press failed: ${msg}` }) }],
        }
      }
    },
  )

  return server
}
