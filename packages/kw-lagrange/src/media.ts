import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import rangeParser from 'range-parser';
import OpenAI from 'openai';
import sharp from 'sharp';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { asJson, CapabilityError, errorText, now, mediaSchema } from '@kwagent/core';
import type { AppConfig, Experience, Json, Media, Store } from '@kwagent/core';
import { z } from 'zod';
import type { MilkyClient } from './client.ts';

/** 媒体 Module 只发布已经登记的内容，并保存每次理解结果。 */
export class MediaModule {
  private readonly key: string;
  constructor(readonly store: Store, readonly config: AppConfig, readonly milky: MilkyClient) {
    const existing = store.meta('media-signing-key');
    this.key = existing ?? randomBytes(32).toString('hex');
    if (!existing) store.setMeta('media-signing-key', this.key);
  }

  async receive(event: Experience, signal?: AbortSignal): Promise<void> {
    if (!event.roleId || event.source !== 'milky' || event.type !== 'message_receive' || this.store.meta(`attachments:${event.id}`)) return;
    const message = z.object({ segments: z.array(z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) })) }).parse(event.payload);
    for (const [index, segment] of message.segments.entries()) {
      if (!['image', 'record', 'video', 'file'].includes(segment.type)) continue;
      try {
        const data = segment.data;
        let uri: string;
        if (typeof data.resource_id === 'string') uri = await this.resourceUrl(data.resource_id, signal);
        else if (typeof data.temp_url === 'string') uri = data.temp_url;
        else if (typeof data.file_id === 'string') {
          const result = await this.milky.call(event.scene === 'group' ? 'get_group_file_download_url' : 'get_private_file_download_url', { file_id: data.file_id, ...(event.scene === 'group' ? { group_id: event.peerId } : {}) }, signal);
          uri = z.object({ download_url: z.string().url() }).parse(result).download_url;
        } else throw new Error('接收附件缺少可查询的资源标识');
        const media = await this.import(event.roleId, uri, typeof data.file_name === 'string' ? data.file_name : undefined, event.id, signal);
        this.store.appendEvent({ id: `attachment:${event.id}:${index}`, accountId: event.accountId, roleId: event.roleId, source: 'media', type: 'media-saved', occurredAt: now(), scene: event.scene, peerId: event.peerId, senderId: event.senderId, messageSeq: null, self: true, payload: { sourceEventId: event.id, segment: index, mediaId: media.id } });
      } catch (error) {
        this.store.appendEvent({ id: `attachment:${event.id}:${index}:failed`, accountId: event.accountId, roleId: event.roleId, source: 'media', type: 'media-failed', occurredAt: now(), scene: event.scene, peerId: event.peerId, senderId: event.senderId, messageSeq: null, self: true, payload: { sourceEventId: event.id, segment: index, reason: errorText(error) } });
        if (signal?.aborted) throw error;
      }
    }
    this.store.setMeta(`attachments:${event.id}`, now());
  }
  async resourceUrl(resourceId: string, signal?: AbortSignal): Promise<string> { return z.object({ url: z.string().url() }).parse(await this.milky.call('get_resource_temp_url', { resource_id: resourceId }, signal)).url; }

  async import(roleId: string, uri: string, name?: string, eventId?: string, signal?: AbortSignal): Promise<Media> {
    this.store.role(roleId);
    if (eventId && this.store.event(eventId).roleId !== roleId) throw new Error('媒体来源属于其他角色');
    let bytes: Buffer;
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      const response = await fetch(uri, { signal });
      if (!response.ok || !response.body) throw new Error(`媒体下载失败：HTTP ${response.status}`);
      const size = Number(response.headers.get('content-length') ?? 0);
      if (size > this.config.mediaMaxBytes) throw new Error('媒体超过配置的下载容量');
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > this.config.mediaMaxBytes) throw new Error('媒体超过配置的下载容量');
          parts.push(part.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      bytes = Buffer.concat(parts);
      name ??= basename(new URL(uri).pathname) || 'resource';
    } else if (uri.startsWith('base64://')) {
      const encoded = uri.slice(9);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Base64 内容无效');
      bytes = Buffer.from(encoded, 'base64');
    } else {
      const path = await realpath(uri.startsWith('file://') ? fileURLToPath(uri) : resolve(uri));
      const workspace = resolve(this.config.dataRoot, 'workspaces', roleId);
      const rel = relative(workspace, path);
      if (rel.startsWith('..') || resolve(workspace, rel) !== path) throw new Error('本地媒体必须位于当前角色工作目录');
      if ((await stat(path)).size > this.config.mediaMaxBytes) throw new Error('媒体超过配置的下载容量');
      bytes = await readFile(path);
      name ??= basename(path);
    }
    if (bytes.length > this.config.mediaMaxBytes) throw new Error('媒体超过配置容量');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const id = `${roleId}-${hash}`;
    const existing = this.store.get('media', id, mediaSchema);
    if (existing) return existing;
    const detected = await fileTypeFromBuffer(bytes);
    const directory = join(this.config.dataRoot, 'media', hash.slice(0, 2));
    await mkdir(directory, { recursive: true });
    const path = join(directory, hash);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const saved = await readFile(path);
      if (createHash('sha256').update(saved).digest('hex') !== hash) throw new Error('媒体内容标识冲突');
    });
    const media: Media = { id, roleId, eventId: eventId ?? null, name: name ?? `resource.${detected?.ext ?? 'bin'}`, path, mime: detected?.mime ?? 'application/octet-stream', bytes: bytes.length, sha256: hash, createdAt: now(), analysis: null };
    this.store.put('media', id, roleId, asJson(media), null, roleId, '保存原始媒体');
    return media;
  }

  async prepare(roleId: string, id: string, mode: 'url' | 'base64' = 'url'): Promise<{ uri: string; expiresAt: string | null }> {
    const media = this.store.media(id);
    if (media.roleId !== roleId) throw new Error('媒体属于其他角色');
    if (mode === 'base64') {
      if (media.bytes > 4 * 1024 * 1024) throw new Error('超过 4 MiB 的媒体请使用签名 URL');
      return { uri: `base64://${(await readFile(media.path)).toString('base64')}`, expiresAt: null };
    }
    if (!this.config.publicUrl) throw new CapabilityError('签名媒体地址需要配置 KW_PUBLIC_URL');
    const expires = Math.floor(Date.now() / 1000) + this.config.mediaLifetimeSeconds;
    const signature = this.signature(id, expires);
    const url = new URL('kw-media', this.config.publicUrl);
    url.search = new URLSearchParams({ id, expires: String(expires), signature }).toString();
    return { uri: url.href, expiresAt: new Date(expires * 1000).toISOString() };
  }
  private signature(id: string, expires: number): string { return createHmac('sha256', this.key).update(`${id}\n${expires}`).digest('hex'); }
  async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') ?? '';
    const expires = Number(url.searchParams.get('expires'));
    const supplied = url.searchParams.get('signature') ?? '';
    if (!id || !Number.isSafeInteger(expires) || expires < Date.now() / 1000 || !/^[a-f0-9]{64}$/.test(supplied)) return new Response('资源授权无效或已过期', { status: 403 });
    if (!timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(this.signature(id, expires), 'hex'))) return new Response('资源授权无效', { status: 403 });
    const media = this.store.get('media', id, mediaSchema);
    if (!media) return new Response('资源不存在', { status: 404 });
    const headers = new Headers({ 'Content-Type': media.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(media.name)}` });
    const range = request.headers.get('range');
    let start = 0; let end = media.bytes - 1; let status = 200;
    if (range) {
      const parsed = rangeParser(media.bytes, range, { combine: true });
      if (typeof parsed === 'number' || parsed.type !== 'bytes' || parsed.length !== 1) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${media.bytes}` } });
      start = parsed[0]!.start; end = parsed[0]!.end; status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${media.bytes}`);
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    if (request.method === 'HEAD' || !media.bytes) return new Response(null, { status, headers });
    const stream = Readable.toWeb(createReadStream(media.path, { start, end }));
    return new Response(stream as ReadableStream<Uint8Array>, { status, headers });
  }

  async inspect(roleId: string, id: string, prompt = '请完整描述这份内容，区分可见事实与推测。', signal?: AbortSignal): Promise<Json> {
    try { return await this.analyze(roleId, id, prompt, signal); }
    catch (error) {
      this.store.appendEvent({ accountId: this.store.role(roleId).accountId, roleId, source: 'media', type: 'media-analysis-failed', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: { mediaId: id, reason: errorText(error) } });
      throw error;
    }
  }
  private async analyze(roleId: string, id: string, prompt: string, signal?: AbortSignal): Promise<Json> {
    const media = this.store.media(id);
    if (media.roleId !== roleId) throw new Error('媒体属于其他角色');
    let result: Json;
    if (media.mime.startsWith('image/')) {
      result = { description: await this.describeImage(roleId, await sharp(media.path).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer(), prompt, signal) };
    } else if (media.mime.startsWith('audio/')) {
      if (!media.eventId) throw new CapabilityError('Lagrange 语音转写需要原始 QQ 语音消息，请提供来源 eventId');
      const event = this.store.event(media.eventId);
      if (event.peerId === null || event.messageSeq === null) throw new Error('语音来源缺少会话和消息序号');
      result = await this.milky.call('transcribe_voice', { message_scene: event.scene === 'group' ? 'group' : 'friend', peer_id: event.peerId, message_seq: event.messageSeq }, signal);
    } else if (media.mime.startsWith('video/')) {
      const temp = join(this.config.dataRoot, 'tmp', `video-${randomBytes(8).toString('hex')}`);
      await mkdir(temp, { recursive: true });
      await this.ffmpeg(['-i', media.path, '-vf', 'fps=1/15,scale=1280:-2', '-frames:v', '8', join(temp, 'frame-%02d.jpg')], signal);
      const { readdir } = await import('node:fs/promises');
      const frames = (await readdir(temp)).filter(name => name.endsWith('.jpg')).sort();
      const descriptions: string[] = [];
      for (const frame of frames) descriptions.push(await this.describeImage(roleId, await readFile(join(temp, frame)), prompt, signal));
      result = { frames: descriptions, audio: { state: 'extraction-available', instruction: '可使用 extract_audio 提取音轨。提取文件需要可处理本地音频的独立语音识别工具。' } };
    } else if (extname(media.name).toLowerCase() === '.pdf' || media.mime === 'application/pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loading = getDocument({ data: new Uint8Array(await readFile(media.path)), useSystemFonts: true });
      const document = await loading.promise;
      try {
        const pages: string[] = [];
        for (let page = 1; page <= document.numPages; page++) {
          const content = await (await document.getPage(page)).getTextContent();
          pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' '));
        }
        result = { pages };
      } finally { await loading.destroy(); }
    } else if (extname(media.name).toLowerCase() === '.docx') {
      result = { text: (await mammoth.extractRawText({ path: media.path })).value };
    } else if (['.xlsx', '.xls', '.csv', '.tsv'].includes(extname(media.name).toLowerCase())) {
      const workbook = XLSX.read(await readFile(media.path));
      result = asJson(Object.fromEntries(workbook.SheetNames.map(name => [name, XLSX.utils.sheet_to_json(workbook.Sheets[name]!, { header: 1 })])));
    } else {
      const bytes = await readFile(media.path);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      result = { text };
    }
    const row = this.store.db.prepare("SELECT revision FROM documents WHERE kind='media' AND id=?").get(id);
    this.store.put('media', id, roleId, asJson({ ...media, analysis: result }), Number(row?.revision), roleId, '保存媒体理解结果');
    this.store.appendEvent({ accountId: this.store.role(roleId).accountId, roleId, source: 'media', type: 'media-analysis', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: { mediaId: id, result } });
    return result;
  }
  async extractAudio(roleId: string, id: string, signal?: AbortSignal): Promise<Media> {
    const media = this.store.media(id);
    if (media.roleId !== roleId) throw new Error('媒体属于其他角色');
    const directory = join(this.config.dataRoot, 'workspaces', roleId, 'media');
    await mkdir(directory, { recursive: true });
    const output = join(directory, `${media.sha256}.wav`);
    await this.ffmpeg(['-i', media.path, '-vn', '-ac', '1', '-ar', '16000', output], signal);
    return this.import(roleId, pathToFileURL(output).href, 'audio.wav', media.eventId ?? undefined, signal);
  }
  private async describeImage(roleId: string, bytes: Buffer, prompt: string, signal?: AbortSignal): Promise<string> {
    const config = this.config.vision;
    if (!config.baseUrl || !config.model) throw new CapabilityError('请配置支持图片输入的聊天模型，或设置 KW_VISION_BASE_URL 和 KW_VISION_MODEL');
    const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey ?? '', maxRetries: 0 });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timeZone }).format(new Date());
    this.store.addUsage(roleId, day, 0);
    const response = await client.chat.completions.create({ model: config.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }] }] }, { signal });
    const text = response.choices[0]?.message.content;
    this.store.addUsage(roleId, day, response.usage?.total_tokens ?? 0, 0);
    if (!text) throw new Error('视觉模型没有返回内容');
    return text;
  }
  private ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', ...args], { signal, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: join(this.config.dataRoot, 'tmp') } });
      let errors = '';
      child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-16384); });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`FFmpeg 处理失败：${errors}`)));
    });
  }
}
