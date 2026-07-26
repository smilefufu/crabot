export interface MediaHandleRecord {
  kind: 'image' | 'file'
  filename?: string
  mime_type?: string
  size?: number
  /** crabot 内部 session id；供慢档完成事件按会话路由唤醒等待 task */
  session_id?: string
  /** 首次下载成功后写回的本地路径；再次 fetch 文件仍在则直接返回 */
  downloaded_file_path?: string
  /** 渠道特定下载凭证（feishu: {platform_message_id, file_key}；telegram: {file_id}；wechat: {url?, message_id}，url 缺失时凭 message_id 重查 connector 消息记录取迟到的 file_url）。由该渠道的 download 适配函数解读。 */
  credential: Record<string, unknown>
}

export interface FetchMediaResult {
  status: 'ready' | 'fetching' | 'failed'
  file_path?: string
  mime_type?: string
  size?: number
  error?: string
}

export interface DownloadResult {
  filePath: string
  mimeType?: string
  size: number
}

/** 渠道提供的下载适配函数：凭 record 下载落盘，返回结果或 null（失败） */
export type MediaDownloadFn = (rec: MediaHandleRecord) => Promise<DownloadResult | null>
