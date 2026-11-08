import { BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { asJson, characterDraftSchema, characterGenerateSchema, EvidenceError, errorText } from '@kwagent/core';
import type { Mind } from './index.ts';
import { parseModelOutput } from './model-output.ts';
import { randomUUID } from 'node:crypto';
import { roleSchema } from '@kwagent/core';

export const characterInstructions = '根据用户的一句话创作完整、连贯、可以长期演绎的角色和世界。生成名称、ASCII标识、初始设定、当前人格、自我状态、2至10条不同场合的表达示例，以及世界条目。初始设定应涵盖身份来历、性格与矛盾、价值观、兴趣习惯、表达与相处方式、当前处境、持续关注、能力边界及其世界中的位置。persona是可以直接用于角色演绎的完整人格，保持角色身份与世界观，不使用宿主AI身份解释自己。世界条目描述环境、规则、地点、历史、社会关系与可延续的事情；人物和世界彼此吻合，不强行加入未要求的恋爱关系。worldMode依据描述选择real/fictional/mixed；虚构条目realm=fictional，现实内容是设定或认识，不能宣称已经核验。禁止生成真实账号绑定、管理员、接口、凭据、已发送消息或已执行活动。id使用简短ASCII字母数字与连字符。只返回符合以下JSON Schema的单个JSON对象：\n' + JSON.stringify(characterDraftSchema.toJSONSchema());

export async function generateCharacter(mind: Mind, value: unknown, signal: AbortSignal) {
  const input = characterGenerateSchema.parse(value);
  const preset = mind.models.get(input.chatPresetId);
  if (preset.kind !== 'chat') throw new EvidenceError('请选择聊天模型方案生成角色');
  const selection = mind.models.selection({ provider: mind.models.provider(preset), model: preset.model, chatPresetId: preset.id, reasoningEffort: input.reasoningEffort ?? null });
  const info = await mind.host.llm.resolveModelInfo(selection.provider, selection.model, signal);
  if (selection.reasoningEffort && !info.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new EvidenceError('所选模型不支持这个推理等级');
  let correction: { output: string; reason: string; operationId: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const operation = mind.store.startOperation('main', null, 'role_generate', asJson({ ...input, provider: selection.provider, model: selection.model, ...correction ? { retryOf: correction.operationId } : {} }));
    const assembler = new BlockAssembler();
    const messages: GenerateOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: input.idea }] }, ...correction ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: `只修正以下草稿的JSON格式与校验错误，保留创意和完整角色内容。字符串内的引号和换行必须正确转义，只返回一个完整JSON对象。错误：${correction.reason}\n草稿：\n${correction.output}` }] }] : []];
    try {
      for await (const chunk of mind.host.llm.stream({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) } : {}), system: characterInstructions, messages, signal })) assembler.push(chunk);
      signal.throwIfAborted();
      if (assembler.finish.kind !== 'stop') throw new EvidenceError(`角色生成尚未完成：${assembler.finish.kind}`);
      const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
      const parsed = parseModelOutput(characterDraftSchema, text);
      if (mind.store.get('role', parsed.value.id, roleSchema)) parsed.value.id = `${parsed.value.id.slice(0, 56)}-${randomUUID().slice(0, 6)}`;
      mind.store.finishOperation(operation.id, 'succeeded', asJson({ draft: parsed.value, usage: assembler.usage ?? null, formatRepaired: parsed.repaired }));
      return { ...parsed.value, generationId: operation.id };
    } catch (error) {
      mind.store.finishOperation(operation.id, 'failed', asJson({ message: errorText(error), output: assembler.blocks(), usage: assembler.usage ?? null }));
      if (attempt === 0 && !signal.aborted && assembler.finish.kind === 'stop' && error instanceof EvidenceError) {
        correction = { output: assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join(''), reason: errorText(error), operationId: operation.id };
        continue;
      }
      throw error;
    }
  }
  throw new Error('角色生成没有产生明确结果');
}
