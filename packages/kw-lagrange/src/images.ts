import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import OpenAI, { toFile } from 'openai';
import type { ImageGenerateParamsNonStreaming, ImageEditParamsNonStreaming, ImagesResponse } from 'openai/resources/images';
import sharp from 'sharp';
import { asJson, errorText, now, redact, type Json, type ModelPresets, type Payloads } from '@kwagent/core';
import type { MediaModule } from './media.ts';

const imageOptions = {
  prompt: z.string().trim().min(1).max(32000).describe('需要生成的画面或对原图的具体修改要求'),
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().regex(/^(auto|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$/).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  background: z.enum(['auto', 'transparent', 'opaque']).optional(),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
};
export const imageGenerateSchema = z.object(imageOptions).strict();
export const imageEditSchema = z.object({ ...imageOptions, imageIds: z.array(z.string().min(1)).min(1).max(16).describe('当前角色已登记媒体的 mediaId，首张为主要编辑图'), maskId: z.string().min(1).optional().describe('可选透明 PNG 蒙版的 mediaId，与首张图片尺寸相同，透明区域为修改区域'), inputFidelity: z.enum(['low', 'high']).optional() }).strict();
type ImageRequest = z.infer<typeof imageGenerateSchema> | z.infer<typeof imageEditSchema>;

/** 图片请求复用媒体归属、持久保存和任务取消；模型只收到可读取的媒体引用。 */
export class ImagesModule {
  constructor(readonly media: MediaModule, readonly models: ModelPresets, readonly payloads: Payloads) {}
  async run(roleId: string, action: 'generate' | 'edit', input: ImageRequest, signal?: AbortSignal): Promise<Json> {
    const editing = action === 'edit' ? imageEditSchema.parse(input) : null;
    const request = editing ?? imageGenerateSchema.parse(input);
    const { preset, apiKey } = await this.models.connection(roleId, 'image');
    const client = new OpenAI({ apiKey, baseURL: preset.baseUrl, timeout: preset.timeoutMs, maxRetries: 0 });
    const body = {
      model: preset.model, prompt: request.prompt,
      ...request.n === undefined ? {} : { n: request.n },
      ...request.size === undefined ? {} : { size: request.size },
      ...request.quality === undefined ? {} : { quality: request.quality },
      ...request.background === undefined ? {} : { background: request.background },
      ...request.outputFormat === undefined ? {} : { output_format: request.outputFormat },
      ...request.outputCompression === undefined ? {} : { output_compression: request.outputCompression },
      ...preset.responseFormat === 'auto' ? {} : { response_format: preset.responseFormat },
    } satisfies ImageGenerateParamsNonStreaming;
    if (request.outputCompression !== undefined && request.outputFormat !== 'jpeg' && request.outputFormat !== 'webp') throw new Error('outputCompression 需要同时选择 jpeg 或 webp 格式');
    const file = async (id: string) => {
      const image = this.media.store.media(id);
      if (image.roleId !== roleId) throw new Error('输入图片属于其他角色');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)) throw new Error('编辑输入需要 PNG、JPEG 或 WebP 图片');
      signal?.throwIfAborted();
      const bytes = await readFile(image.path, { signal });
      const metadata = await sharp(bytes).metadata();
      return { file: await toFile(bytes, `image-${image.sha256}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`, { type: image.mime }), metadata };
    };
    let edit: ImageEditParamsNonStreaming | undefined;
    if (editing) {
      const images = await Promise.all(editing.imageIds.map(file));
      const mask = editing.maskId ? await file(editing.maskId) : undefined;
      if (mask && (mask.metadata.format !== 'png' || !mask.metadata.hasAlpha || mask.metadata.width !== images[0]!.metadata.width || mask.metadata.height !== images[0]!.metadata.height)) throw new Error('蒙版必须是带透明通道的 PNG，且与首张输入图片尺寸相同');
      edit = { ...body, image: images.map(image => image.file), ...mask ? { mask: mask.file } : {}, ...editing.inputFidelity ? { input_fidelity: editing.inputFidelity } : {} };
    }
    signal?.throwIfAborted();
    const role = this.media.store.role(roleId);
    const operation = this.media.store.startOperation(role.accountId, roleId, `image_${action}`, asJson({ ...request, presetId: preset.id, presetRevision: preset.revision, model: preset.model }));
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.media.config.timeZone }).format(new Date());
    this.media.store.addUsage(roleId, day, 0);
    let responseRef: Json = null;
    try {
      const response: ImagesResponse = edit ? await client.images.edit(edit, { signal }) : await client.images.generate(body, { signal });
      responseRef = asJson(await this.payloads.put(roleId, `image:${operation.id}`, asJson(response)));
      const tokens = response.usage?.total_tokens ?? 0;
      this.media.store.addUsage(roleId, day, tokens, 0);
      if (!response.data?.length) throw new Error('生图接口没有返回图片，原始结果已保存');
      const images: Json[] = [];
      for (const [index, item] of response.data.entries()) {
        signal?.throwIfAborted();
        const uri = item.b64_json ? `base64://${item.b64_json}` : item.url;
        if (!uri) throw new Error(`第 ${index + 1} 张图片缺少 b64_json 或 url，原始结果已保存`);
        const remote = item.b64_json ? null : new URL(uri);
        if (remote && !['http:', 'https:'].includes(remote.protocol)) throw new Error('接口返回的图片 URL 必须使用 HTTP 或 HTTPS');
        const trustedOrigin = remote?.origin === new URL(preset.baseUrl).origin;
        const image = await this.media.import(roleId, uri, `image-${operation.id}-${index + 1}.${request.outputFormat ?? 'png'}`, undefined, signal, trustedOrigin);
        if (!image.mime.startsWith('image/')) throw new Error('生图接口返回的内容不是图片');
        const metadata = await sharp(image.path).metadata();
        images.push(asJson({ mediaId: image.id, path: image.path, mime: image.mime, bytes: image.bytes, width: metadata.width ?? null, height: metadata.height ?? null, revisedPrompt: item.revised_prompt ?? null }));
      }
      const result = asJson({ operationId: operation.id, presetId: preset.id, model: preset.model, action, images, resultRef: responseRef, usage: response.usage ?? null, createdAt: now(), instruction: '图片已生成并持久保存。按需读取或通过 media_prepare({mediaId}) 准备发送资源；是否发送由你决定，生成成功不表示已经发送。' });
      this.media.store.finishOperation(operation.id, 'succeeded', result);
      return result;
    } catch (error) {
      const definitive = error instanceof OpenAI.APIError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408;
      this.media.store.finishOperation(operation.id, definitive ? 'failed' : 'unknown', asJson({ error: redact(errorText(error), this.media.config), resultRef: responseRef, instruction: '未确认已完成全部图片保存；结果未知时先读取已有操作与结果，不要盲目重复请求。' }));
      throw error;
    }
  }
}
