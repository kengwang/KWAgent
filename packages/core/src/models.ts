import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-settings';
import type { Store } from './store.ts';
import { asJson, CapabilityError, ConflictError, now, type Role } from './types.ts';
import { rememberSecret, type AppConfig } from './config.ts';

const endpoint = z.string().url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, 'API 地址应为 HTTP 或 HTTPS 根地址，不包含凭据、查询参数或片段');
export const modelPresetSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), name: z.string().trim().min(1).max(120),
  kind: z.enum(['chat', 'vision', 'image']), baseUrl: endpoint, model: z.string().trim().min(1).max(240),
  protocol: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']).default('openai-completions'),
  thinkingFormat: z.enum(['auto', 'openai', 'deepseek']).default('auto'),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high']).nullable().default(null),
  imageInput: z.boolean().default(true), timeoutMs: z.number().int().positive().max(3600000).default(300000),
  responseFormat: z.enum(['auto', 'b64_json', 'url']).default('auto'),
  revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().default(null),
});
export type ModelPreset = z.infer<typeof modelPresetSchema>;
export const modelPresetWriteSchema = modelPresetSchema.omit({ revision: true, createdAt: true, updatedAt: true, deletedAt: true }).extend({
  expectedRevision: z.number().int().positive().nullable(), apiKey: z.string().trim().min(1).max(8192).regex(/^[^\r\n]+$/, 'API Key 不能包含换行').optional(), clearApiKey: z.boolean().default(false),
}).strict().refine(value => !(value.apiKey && value.clearApiKey), '更新和清除 API Key 不能同时选择');
export type ModelPresetWrite = z.infer<typeof modelPresetWriteSchema>;
export interface ModelConnection { preset: ModelPreset; apiKey: string }
export type PublicModelPreset = ModelPreset & { provider: string | null; readonly: boolean; credentialConfigured: boolean };

/** 预设正文与凭据分开保存，聊天路由通过 Harness 的公开配置接口登记。 */
export class ModelPresets {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly ctx: Context, readonly store: Store, readonly config: AppConfig) {}
  private serial<T>(work: () => Promise<T>): Promise<T> { const task = this.tail.then(work); this.tail = task.catch(() => undefined); return task; }
  private ref(id: string) { return credentialRef(`KW_MODEL_${createHash('sha256').update(id).digest('hex').toUpperCase()}`); }
  provider(preset: ModelPreset): string { return preset.id === 'env-chat' ? this.config.chat.provider : `kw-preset-${preset.id}`; }
  private environment(): ModelPreset[] {
    return (['chat', 'vision', 'image'] as const).flatMap(kind => {
      const config = kind === 'image' ? this.config.images : this.config[kind];
      if (!config.baseUrl || !config.model) return [];
      return [modelPresetSchema.parse({ id: `env-${kind}`, name: { chat: '部署默认聊天', vision: '部署默认视觉', image: '部署默认生图' }[kind], kind, baseUrl: config.baseUrl, model: config.model, revision: 1, createdAt: '', updatedAt: '' })];
    });
  }
  get(id: string): ModelPreset {
    const preset = this.environment().find(preset => preset.id === id) ?? this.store.get('model-preset', id, modelPresetSchema);
    if (!preset || preset.deletedAt) throw new CapabilityError(`模型预设不存在或已删除：${id}`);
    return preset;
  }
  private async public(preset: ModelPreset): Promise<PublicModelPreset> {
    const readonly = preset.id.startsWith('env-');
    const environment = preset.kind === 'image' ? this.config.images : this.config[preset.kind];
    const credentialConfigured = readonly ? Boolean(environment.apiKey) : (await this.ctx.credentials.describe(this.ref(preset.id))).configured;
    return { ...preset, provider: preset.kind === 'chat' ? this.provider(preset) : null, readonly, credentialConfigured };
  }
  async read(id: string): Promise<PublicModelPreset> { return this.public(this.get(id)); }
  async list(kind?: ModelPreset['kind'], cursor = 0, limit = 50) {
    const all = [...this.environment(), ...this.store.list('model-preset', modelPresetSchema, undefined, 10000).filter(preset => !preset.deletedAt)].filter(preset => !kind || preset.kind === kind);
    return { items: await Promise.all(all.slice(cursor, cursor + limit).map(preset => this.public(preset))), nextCursor: all.length > cursor + limit ? cursor + limit : null };
  }
  private async chatRoute(preset: ModelPreset, remove = false): Promise<void> {
    const descriptor = this.ctx.settings.describe().find(item => item.ns === 'llm-pi-ai');
    if (!descriptor) throw new CapabilityError('Harness 的 llm-pi-ai 配置入口尚未就绪');
    const route = this.provider(preset);
    const value = {
      displayName: preset.name, api: preset.protocol, baseURL: preset.baseUrl, apiKeyEnv: this.ref(preset.id), timeoutMs: preset.timeoutMs,
      defaultInput: preset.imageInput ? ['text', 'image'] : ['text'],
      ...(preset.thinkingFormat === 'auto' ? {} : { compat: { thinkingFormat: preset.thinkingFormat } }),
      ...(preset.reasoningEffort ? { reasoning: preset.reasoningEffort } : {}),
      models: [{ id: preset.model, name: preset.model, ...(preset.thinkingFormat === 'auto' && preset.reasoningEffort === null ? {} : { reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } }) }],
    };
    await this.ctx.settings.mutate(descriptor.ns, [remove ? { op: 'unset', path: ['providers', route] } : { op: 'set', path: ['providers', route], value }], descriptor.revision);
  }
  async restore(): Promise<void> {
    for (const preset of this.store.list('model-preset', modelPresetSchema, undefined, 10000)) {
      const secret = await this.ctx.credentials.resolve(this.ref(preset.id)); if (secret) rememberSecret(secret.value);
      if (preset.kind === 'chat') await this.chatRoute(preset, Boolean(preset.deletedAt));
    }
  }
  save(input: ModelPresetWrite): Promise<PublicModelPreset> {
    return this.serial(async () => {
      const parsed = modelPresetWriteSchema.parse(input);
      if (parsed.id.startsWith('env-')) throw new Error('部署默认预设通过环境配置管理，请使用其他标识创建预设');
      const previous = this.store.get('model-preset', parsed.id, modelPresetSchema);
      if (parsed.expectedRevision === null ? previous !== undefined : previous?.revision !== parsed.expectedRevision) throw new ConflictError(previous ? asJson(await this.public(previous)) : null);
      if (previous && (previous.kind !== parsed.kind || previous.deletedAt)) throw new Error('预设类型不能修改，已删除标识不能重新使用');
      const { expectedRevision, apiKey, clearApiKey, ...data } = parsed;
      const preset = modelPresetSchema.parse({ ...data, revision: (expectedRevision ?? 0) + 1, createdAt: previous?.createdAt ?? now(), updatedAt: now() });
      if (apiKey) { rememberSecret(apiKey); await this.ctx.credentials.set(this.ref(preset.id), apiKey); }
      if (clearApiKey) await this.ctx.credentials.unset(this.ref(preset.id));
      if (preset.kind === 'chat') await this.chatRoute(preset);
      this.store.put('model-preset', preset.id, null, asJson(preset), expectedRevision, 'owner', '保存模型预设');
      return this.public(preset);
    });
  }
  remove(id: string, expectedRevision: number): Promise<{ deleted: true }> {
    return this.serial(async () => {
      if (id.startsWith('env-')) throw new Error('部署默认预设不能删除');
      const preset = this.get(id);
      if (preset.revision !== expectedRevision) throw new ConflictError(asJson(await this.public(preset)));
      const users = this.store.roles().filter(role => [role.chatPresetId, role.visionPresetId, role.imagePresetId].includes(id) || preset.kind === 'chat' && role.provider === this.provider(preset));
      if (users.length) throw new Error(`预设仍由角色使用：${users.map(role => role.name).join('、')}`);
      if (preset.kind === 'chat') await this.chatRoute(preset, true);
      this.store.put('model-preset', id, null, asJson({ ...preset, deletedAt: now(), updatedAt: now(), revision: expectedRevision + 1 }), expectedRevision, 'owner', '删除模型预设');
      await this.ctx.credentials.unset(this.ref(id));
      return { deleted: true };
    });
  }
  effective<T extends Pick<Role, 'provider' | 'model'> & Partial<Pick<Role, 'chatPresetId' | 'visionPresetId' | 'imagePresetId'>>>(role: T): T {
    for (const [field, kind] of [['chatPresetId', 'chat'], ['visionPresetId', 'vision'], ['imagePresetId', 'image']] as const) {
      const id = role[field]; if (id && this.get(id).kind !== kind) throw new Error(`${field} 需要选择 ${kind} 类型的模型预设`);
    }
    if (!role.chatPresetId) return role;
    const preset = this.get(role.chatPresetId);
    return { ...role, provider: this.provider(preset), model: preset.model };
  }
  async connection(roleId: string, kind: 'vision' | 'image'): Promise<ModelConnection> {
    const role = this.store.role(roleId);
    const id = kind === 'image' ? role.imagePresetId : role.visionPresetId;
    let preset: ModelPreset;
    if (id) preset = this.get(id);
    else if (kind === 'vision' && role.chatPresetId && this.get(role.chatPresetId).protocol === 'openai-completions') preset = this.get(role.chatPresetId);
    else {
      const fallback = this.environment().find(preset => preset.kind === kind);
      if (!fallback) throw new CapabilityError(`请在模型配置页面创建${kind === 'image' ? '生图' : '视觉'}预设，并在角色中选择`);
      preset = fallback;
    }
    if (preset.kind !== kind && !(kind === 'vision' && preset.kind === 'chat' && preset.imageInput)) throw new CapabilityError('所选模型预设不支持当前用途');
    const environment = preset.kind === 'image' ? this.config.images : this.config[preset.kind];
    const apiKey = preset.id.startsWith('env-') ? environment.apiKey : (await this.ctx.credentials.resolve(this.ref(preset.id)))?.value;
    if (!apiKey) throw new CapabilityError(`模型预设“${preset.name}”尚未配置 API Key`);
    rememberSecret(apiKey);
    return { preset, apiKey };
  }
}
