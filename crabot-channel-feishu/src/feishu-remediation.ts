import { buildScopeGrantUrl } from './onboard.js'

type Brand = 'feishu' | 'lark'

export interface FeishuRemediation {
  message: string
  grant_url: string
  steps: string[]
  alternatives: string[]
  /** 飞书原始错误码，如 41050（no user authority） */
  feishu_code?: number
  /** 飞书原始错误描述，保留给诊断用途 */
  feishu_message?: string
}

const WRITE_SCOPE_BY_PREFIX: Array<[string, string]> = [
  ['/open-apis/docx/', 'docx:document'],
  ['/open-apis/sheets/', 'sheets:spreadsheet'],
  ['/open-apis/drive/', 'drive:drive'],
  ['/open-apis/wiki/', 'wiki:wiki'],
  ['/open-apis/bitable/', 'bitable:app'],
]

/** 按 path 前缀映射飞书写 scope；未命中返回 undefined。 */
export function writeScopeForPath(path: string): string | undefined {
  return WRITE_SCOPE_BY_PREFIX.find(([p]) => path.startsWith(p))?.[1]
}

/** 把「飞书权限不足」翻译成人类可读、可操作的引导。agent 可直接转述。 */
export function buildFeishuRemediation(opts: {
  appId: string
  domain: Brand
  missingScope: string
  intent?: 'read' | 'write'
  feishu_code?: number
  feishu_message?: string
}): FeishuRemediation {
  const grant_url = buildScopeGrantUrl(opts.appId, opts.domain, [opts.missingScope])
  const isWrite = opts.intent === 'write'
  const is41050 = opts.feishu_code === 41050

  let message: string
  if (is41050) {
    message = isWrite
      ? `我没有修改这个内容的飞书权限。开通 ${opts.missingScope} scope 只是必要条件，还需要该资源把当前应用（或 Bot）加入协作者才能读写。如果资源来自外部租户，外部租户管理员还需要在飞书管理后台配置跨租户数据访问策略。`
      : `我没有读取这个内容的飞书权限。开通 ${opts.missingScope} scope 只是必要条件，还需要该资源把当前应用（或 Bot）加入协作者才能读取。如果资源来自外部租户，外部租户管理员还需要在飞书管理后台配置跨租户数据访问策略。`
  } else {
    message = isWrite
      ? `我没有修改这个内容所需的飞书权限（缺 ${opts.missingScope}）。点下面的链接给应用开通该权限，再通过飞书开发者后台创建版本并发布才生效。`
      : `我没有读取这个内容所需的飞书权限（缺 ${opts.missingScope}）。点下面的链接给应用开通该权限，再通过飞书开发者后台创建版本并发布才生效。`
  }

  const steps: string[] = [
    '点授权链接开通该权限，然后在飞书开发者后台进入「应用发布 → 版本管理与发布」创建版本并提交，scope 才生效',
    '确保本应用（或 Bot）已添加为该文档/文件夹/知识空间的协作者',
  ]
  if (is41050) {
    steps.push('如果资源来自外部租户，需要外部租户管理员在飞书管理后台配置跨租户数据访问策略')
  }

  const alternatives: string[] = isWrite
    ? ['或让有这个文档权限的人在飞书里直接改']
    : [
        '或通过 get_history/get_message 获取消息句柄，用 fetch_media 下载 Word/群附件',
        '或把文件转为当前租户的飞书在线 docx 文档后再发链接',
        '或直接把正文/关键内容贴到群里',
      ]

  return {
    message,
    grant_url,
    steps,
    alternatives,
    feishu_code: opts.feishu_code,
    feishu_message: opts.feishu_message,
  }
}
