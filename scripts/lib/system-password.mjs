import { systemError } from './system-registry.mjs'

// Local administrator interaction only. Disable echo for the whole two-prompt
// exchange before exposing either prompt, including immediately pasted input.
export async function readSystemInitialPassword({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) throw systemError('首次开通请在管理员交互终端设置初始密码；不从命令参数或环境变量读取密码。')
  input.setEncoding('utf8')
  const previousRaw = input.isRaw
  const ask = prompt => new Promise((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onEnd); input.pause()
    }
    const finish = error => {
      cleanup()
      try { output.write('\n') } catch { error ||= systemError('管理员终端不可用，未开通用户。') }
      if (error) reject(error); else resolve(value)
    }
    const onEnd = () => finish(systemError('密码输入已中断，未开通用户。'))
    const onData = bytes => {
      for (const character of bytes.toString()) {
        if (character === '\r' || character === '\n' || character === '\u0003') {
          finish(character === '\u0003' ? systemError('已取消开通。') : null); return
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else if (value.length < 4096) value += character
      }
    }
    try {
      input.on('data', onData); input.once('end', onEnd); input.once('error', onEnd)
      input.resume(); output.write(prompt)
    } catch { cleanup(); reject(systemError('管理员终端不可用，未开通用户。')) }
  })
  try {
    input.setRawMode(true)
    const first = await ask('浏览器初始密码（输入不回显）：')
    const second = await ask('再次输入：')
    if (first.length < 4 || first !== second) throw systemError('密码至少4字符，且两次输入须相同；未开通用户。')
    return first
  } finally { input.setRawMode(previousRaw); input.pause() }
}
