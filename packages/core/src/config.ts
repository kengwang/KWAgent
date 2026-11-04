import { resolve } from 'node:path';
import { z } from 'zod';

const positive = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);
const optionalUrl = z.string().url().optional();
const emptyToUndefined = (value: string | undefined) => value === '' ? undefined : value;

export const configSchema = z.object({
  dataRoot: z.string(), publicUrl: optionalUrl, timeZone: z.string().default('Asia/Shanghai'),
  milky: z.object({ baseUrl: z.string().url(), token: z.string().optional(), timeoutMs: positive(60000), reconcileSeconds: positive(300) }),
  chat: z.object({ baseUrl: optionalUrl, apiKey: z.string().optional(), provider: z.string(), model: z.string().optional() }),
  vision: z.object({ baseUrl: optionalUrl, apiKey: z.string().optional(), model: z.string().optional() }),
  batchMs: positive(1000), memoryTokens: positive(8192), continuityTokens: positive(3072),
  budgets: z.object({ perception: positive(8192), consolidation: positive(16384), tool: positive(2048), panelBodyBytes: positive(4096), snapshotBytes: positive(524288) }),
  backup: z.object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), keepDays: positive(14) }),
  mediaMaxBytes: positive(268435456), mediaLifetimeSeconds: positive(3600),
});
export type AppConfig = z.infer<typeof configSchema>;

/** 从进程环境读取部署配置，凭据只在 Host 内部保留。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = configSchema.parse({
    dataRoot: resolve(env.KW_DATA_ROOT ?? './data'), publicUrl: emptyToUndefined(env.KW_PUBLIC_URL),
    timeZone: env.KW_TIME_ZONE,
    milky: { baseUrl: env.LAGRANGE_BASE_URL ?? 'http://127.0.0.1:3000/', token: emptyToUndefined(env.LAGRANGE_ACCESS_TOKEN), timeoutMs: env.LAGRANGE_TOOL_TIMEOUT_MS, reconcileSeconds: env.LAGRANGE_RECONCILE_INTERVAL_SECONDS },
    chat: { baseUrl: emptyToUndefined(env.KW_CHAT_BASE_URL), apiKey: emptyToUndefined(env.KW_CHAT_API_KEY), provider: env.KW_LLM_PROVIDER ?? 'deepseek-official', model: emptyToUndefined(env.KW_LLM_MODEL) },
    vision: { baseUrl: emptyToUndefined(env.KW_VISION_BASE_URL) ?? emptyToUndefined(env.KW_CHAT_BASE_URL), apiKey: emptyToUndefined(env.KW_VISION_API_KEY) ?? emptyToUndefined(env.KW_CHAT_API_KEY), model: emptyToUndefined(env.KW_VISION_MODEL) ?? emptyToUndefined(env.KW_LLM_MODEL) },
    batchMs: env.KW_EVENT_BATCH_WINDOW_MS, memoryTokens: env.KW_CONTEXT_MEMORY_TOKENS, continuityTokens: env.KW_CONTINUITY_CONTEXT_TOKENS,
    budgets: { perception: env.KW_PERCEPTION_TOKENS, consolidation: env.KW_CONSOLIDATION_TOKENS, tool: env.KW_TOOL_PREVIEW_TOKENS, panelBodyBytes: env.KW_PANEL_BODY_BYTES, snapshotBytes: env.KW_PANEL_SNAPSHOT_BYTES },
    backup: { enabled: env.KW_BACKUP_ENABLED !== 'false', time: env.KW_BACKUP_TIME ?? '03:00', keepDays: env.KW_BACKUP_KEEP_DAYS },
    mediaMaxBytes: env.KW_MEDIA_MAX_BYTES, mediaLifetimeSeconds: env.KW_MEDIA_LIFETIME_SECONDS,
  });
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format();
  for (const key of ['vision'] as const) {
    const provider = config[key];
    if ((provider.baseUrl || provider.model) && !(provider.baseUrl && provider.model)) throw new Error(`${key} 必须同时配置 BASE_URL 和 MODEL`);
  }
  return config;
}

export function publicConfig(config: AppConfig) {
  const provider = (value: AppConfig['vision']) => ({ baseUrl: value.baseUrl ?? null, model: value.model ?? null, credentialConfigured: Boolean(value.apiKey) });
  return {
    timeZone: config.timeZone, publicUrl: config.publicUrl ?? null,
    milky: { baseUrl: config.milky.baseUrl, credentialConfigured: Boolean(config.milky.token) },
    chat: { ...provider(config.chat), provider: config.chat.provider },
    vision: provider(config.vision),
    batchMs: config.batchMs, memoryTokens: config.memoryTokens, continuityTokens: config.continuityTokens, budgets: config.budgets, backup: config.backup,
  };
}

export function redact(text: string, config: AppConfig): string {
  for (const secret of [config.milky.token, config.chat.apiKey, config.vision.apiKey, process.env.DEEPSEEK_API_KEY]) {
    if (secret) text = text.replaceAll(secret, '[REDACTED]');
  }
  return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}
