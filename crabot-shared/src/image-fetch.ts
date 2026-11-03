/** 按需取图契约，见 protocol-channel。 */
export type ImageQuality = 'thumbnail' | 'hd' | 'unknown'

export interface FetchImageParams {
  session_id: string
  platform_message_id: string
  quality: 'hd' | 'thumbnail'
  attachment_id?: string
}

export type FetchImageResult =
  | { status: 'ready'; image_quality: ImageQuality; file_path: string; mime_type: string; size: number }
  | { status: 'not_ready'; image_quality: ImageQuality }
  | { status: 'failed'; error: string }
