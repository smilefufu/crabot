/** 微信按需取图契约，见 protocol-channel「微信图片按需获取」。 */
export type ImageQuality = 'thumbnail' | 'hd' | 'unknown'

export interface FetchImageParams {
  session_id: string
  platform_message_id: string
  quality: 'hd' | 'thumbnail'
}

export type FetchImageResult =
  | { status: 'ready'; image_quality: ImageQuality; file_path: string; mime_type: string; size: number }
  | { status: 'not_ready'; image_quality: ImageQuality }
  | { status: 'failed'; error: string }
