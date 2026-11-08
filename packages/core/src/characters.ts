import { z } from 'zod';
import { asJson, EvidenceError, now, operationSchema, realmSchema, roleInputSchema, type RoleInput } from './types.ts';
import type { Store } from './store.ts';

export const worldSettingSchema = z.object({ title: z.string().trim().min(1).max(240), content: z.string().trim().min(1).max(30000), realm: realmSchema }).strict();
export const characterDraftSchema = z.object({
  id: roleInputSchema.shape.id, name: z.string().trim().min(1).max(120),
  initialPersona: z.string().trim().min(1).max(40000), persona: z.string().trim().min(1).max(40000),
  selfState: z.string().max(10000), expressionExamples: z.array(z.string().min(1).max(4000)).min(2).max(10),
  worldMode: realmSchema, world: z.array(worldSettingSchema).min(1).max(20),
}).strict();
export type CharacterDraft = z.infer<typeof characterDraftSchema>;
export const characterGenerateSchema = z.object({ idea: z.string().trim().min(1).max(10000), chatPresetId: z.string().min(1), reasoningEffort: z.string().nullable().optional() }).strict();
export const characterCreateSchema = roleInputSchema.extend({ world: z.array(worldSettingSchema).max(20).default([]), generationId: z.string().uuid().optional() });

/** 角色与世界设定原子创建；生成内容始终是设定或人工认识。 */
export function createCharacter(store: Store, role: RoleInput, world: z.infer<typeof worldSettingSchema>[] = [], generationId?: string) {
  return store.transaction(() => {
    if (generationId) {
      const operation = store.get('operation', generationId, operationSchema);
      if (!operation || operation.tool !== 'role_generate' || operation.roleId !== null || operation.state !== 'succeeded') throw new EvidenceError('角色生成记录不存在或尚未成功');
    }
    const saved = store.createRole(role);
    if (!world.length) return saved;
    const settings = z.array(worldSettingSchema).parse(world);
    if (saved.worldMode === 'real' && settings.some(setting => setting.realm !== 'real')) throw new EvidenceError('现实生活角色的世界条目需要使用现实情境');
    const source = store.appendEvent({ accountId: saved.accountId, roleId: saved.id, source: 'manual', type: 'character-setting', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: asJson({ meaning: '人工确认的角色与世界设定，不证明外部事实', generationId: generationId ?? null, settings }) }).event;
    for (const setting of settings) store.saveMemory({ roleId: saved.id, kind: 'world', title: setting.title, content: setting.content, realm: setting.realm, epistemic: setting.realm === 'real' ? 'inferred' : 'fictional', people: [], aliases: [], sources: [source.id], archived: false, attention: 0.8 }, null, 'owner', '创建角色时确认世界设定');
    store.markConsolidated([source.id]);
    return saved;
  });
}
