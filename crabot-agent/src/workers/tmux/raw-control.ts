/** Parse the deliberately small raw-control surface exposed to Managers. */

const NAMED_CONTROL_KEYS = new Set([
  'enter', 'escape', 'esc', 'tab', 'btab', 'space', 'bspace',
  'up', 'down', 'left', 'right', 'home', 'end', 'ppage', 'npage', 'dc', 'ic',
  'c-space',
])

const FUNCTION_KEY = /^f(?:[1-9]|1\d|2[0-4])$/i
const MODIFIED_KEY = /^(?:(?:C|M|S)-)+[\x21-\x7e]$/
const SINGLE_CONTROL_KEY = /^[\x01-\x1a\x1c-\x1f\x21-\x7e]$/

export class InvalidRawControlInputError extends Error {
  readonly certainty = 'not_delivered' as const

  constructor() {
    super('raw input must be whitespace-separated tmux control keys, not conversation text')
    this.name = 'InvalidRawControlInputError'
  }
}

/**
 * `tmux send-keys` accepts arbitrary strings, which would turn a mistaken raw
 * message into pane text. Raw delivery is only for navigation/selection keys.
 */
export function parseRawControlKeys(text: string): string[] {
  const keys = text.split(/\s+/).filter((key) => key.length > 0)
  if (keys.length === 0 || keys.some((key) => !isRawControlKey(key))) {
    throw new InvalidRawControlInputError()
  }
  return keys
}

function isRawControlKey(key: string): boolean {
  return SINGLE_CONTROL_KEY.test(key) ||
    NAMED_CONTROL_KEYS.has(key.toLowerCase()) ||
    FUNCTION_KEY.test(key) ||
    MODIFIED_KEY.test(key)
}
