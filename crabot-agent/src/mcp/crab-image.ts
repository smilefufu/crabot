/**
 * Crab-Image MCP Server — builtin Worker 生图能力。
 * generate_image 调用中转站 OpenAI 兼容 /images/generations，落地成文件、返回路径；
 * 不自动发送——Worker 把文件路径作为任务结果返回 Manager，由 Manager 负责投递。
 * spec: crabot-docs/superpowers/specs/2026-07-13-image-generation-design.md
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod/v4'
import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { mcpServerToToolDefinitions } from '../agent/mcp-tool-bridge.js'
import type { ToolDefinition } from '../engine/types.js'

export interface ImageConnInfo {
  endpoint: string
  apikey: string
  model_id: string
}

type FetchLike = typeof fetch

export interface GenerateImageArgs {
  prompt: string
  size?: string
  n?: number
}

export type GenerateImageResult =
  | { success: true; files: string[]; model: string }
  | { success: false; error: string }

/** 纯函数：调接口 + 落盘。与 MCP 解耦，便于单测。 */
export async function generateImage(
  connInfo: ImageConnInfo,
  args: GenerateImageArgs,
  opts: { outputDir: string; fetchImpl?: FetchLike },
): Promise<GenerateImageResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const base = connInfo.endpoint.replace(/\/$/, '')
  const body: Record<string, unknown> = {
    model: connInfo.model_id,
    prompt: args.prompt,
    n: args.n ?? 1,
    response_format: 'b64_json',
  }
  if (args.size) body.size = args.size

  let resp: Response
  try {
    resp = await doFetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connInfo.apikey}` },
      body: JSON.stringify(body),
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return { success: false, error: `生图接口返回 ${resp.status}: ${text.slice(0, 300)}` }
  }

  let data: { data?: Array<{ b64_json?: string; url?: string }> }
  try {
    data = (await resp.json()) as typeof data
  } catch {
    return { success: false, error: '生图接口响应不是合法 JSON，中转站可能不兼容' }
  }
  const items = data.data ?? []
  if (items.length === 0) {
    return { success: false, error: '生图接口响应不含图片数据（data 为空），中转站可能不兼容' }
  }

  await fs.mkdir(opts.outputDir, { recursive: true })
  const files: string[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const filePath = path.join(opts.outputDir, `img-${Date.now()}-${i}.png`)
    if (it.b64_json) {
      await fs.writeFile(filePath, Buffer.from(it.b64_json, 'base64'))
    } else if (it.url) {
      let imgResp: Response
      try {
        imgResp = await doFetch(it.url)
      } catch (error) {
        return { success: false, error: `下载生成图片失败：${error instanceof Error ? error.message : String(error)}` }
      }
      if (!imgResp.ok) return { success: false, error: `下载生成图片失败 ${imgResp.status}` }
      await fs.writeFile(filePath, Buffer.from(await imgResp.arrayBuffer()))
    } else {
      return { success: false, error: '生图响应项既无 b64_json 也无 url' }
    }
    files.push(filePath)
  }
  return { success: true, files, model: connInfo.model_id }
}

const GENERATE_IMAGE_SCHEMA = {
  prompt: z.string().describe('图片内容描述，越具体越好'),
  size: z.string().optional().describe("尺寸，如 '1024x1024'；不传由模型决定"),
  n: z.number().int().min(1).max(4).optional().describe('生成张数，默认 1'),
}

export interface CrabImageDeps {
  connInfo: ImageConnInfo
  moduleId: string
  outputDir: string
  fetchImpl?: FetchLike
}

export function createCrabImageServer(deps: CrabImageDeps): McpServer {
  const server = createMcpServer({ name: 'crab-image', version: '1.0.0' })
  server.registerTool(
    'generate_image',
    {
      description:
        '根据文字描述生成图片并返回本地文件路径（不自动发送）；把路径和必要说明作为任务结果返回 Manager。',
      inputSchema: GENERATE_IMAGE_SCHEMA,
    },
    async (args) => {
      const res = await generateImage(deps.connInfo, args, {
        outputDir: deps.outputDir,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      })
      if (!res.success) console.error(`[${deps.moduleId}] generate_image failed: ${res.error}`)
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] }
    },
  )
  return server
}

/** connInfo 存在才暴露 generate_image 工具；否则返回空（agent 手上没有会失败的工具） */
export function imageToolsFor(
  connInfo: ImageConnInfo | undefined,
  opts: { moduleId: string; outputDir: string; fetchImpl?: FetchLike },
): ToolDefinition[] {
  if (!connInfo) return []
  const server = createCrabImageServer({
    connInfo,
    moduleId: opts.moduleId,
    outputDir: opts.outputDir,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })
  return mcpServerToToolDefinitions(server, 'crab-image')
}

/** 从推送的 config.image_config 提取 ImageConnInfo（存引用解析后的连接信息） */
export function toImageConnInfo(
  config: { image_config?: { endpoint: string; apikey: string; model_id: string } },
): ImageConnInfo | undefined {
  const c = config.image_config
  if (!c) return undefined
  return { endpoint: c.endpoint, apikey: c.apikey, model_id: c.model_id }
}
