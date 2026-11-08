import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { consolidationInstructions, consolidationSchema, parseConsolidationOutput, consolidationMessages, consolidationCorrectionInput } from '@kwagent/kw-mind';
import { tokens } from '@kwagent/core';
import { jsonrepair } from 'jsonrepair';

export const name = 'kwagent-auxiliary-cost-verification';
export const inject = ['kwLife', 'webServer', 'tools'];
export function apply(ctx) {
  if (process.env.KW_AUXILIARY_TEST !== 'true' || new URL(process.env.KW_PUBLIC_URL).hostname !== '127.0.0.1') throw new Error('只允许隔离的本机辅助请求验收');
  const life = ctx.kwLife, mind = life.context.kwMind, id = 'auxiliary-probe';
  ctx.tools.guard(exec => /mcp__lagrange__/.test(exec.name) ? '辅助请求验收禁止社交工具' : undefined);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/kw-auxiliary-cost-test', handler: async (request, response) => {
    const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    try {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'));
      if (body.action === 'seed') {
        const source = life.manual(id, '资料记录：我正在阅读红楼梦，希望继续讨论人物的处境。');
        for (let index = 0; index < 60; index++) life.store.saveMemory({ roleId: id, kind: 'world', title: `遥远行星${index}`, content: `关于行星${index}的沙尘与气压资料。`.repeat(50), realm: 'fictional', epistemic: 'fictional', people: [], aliases: [], sources: [source.id], archived: false, attention: 0.5 }, null, 'owner', '填入隔离检索材料');
        life.store.saveMemory({ roleId: id, kind: 'episode', title: '红楼梦阅读', content: '希望延续红楼梦阅读讨论。', realm: 'real', epistemic: 'reported', people: ['10001'], aliases: [], sources: [source.id], archived: false, attention: 0.5 }, null, 'owner', '实际输入资料');
        life.store.markConsolidated([source.id]);
        for (let index = 0; index < 20; index++) life.manual(id, `阅读进度更新：今天阅读红楼梦第${index + 1}回，注意到人物之间的误解，之后想结合各自处境继续讨论。`, 'manual', { context: { scene: 'private', peerId: 10001 }, sender: { id: 10001, nickname: '阅读者' } });
        return send({ due: mind.consolidationDue(id), pending: life.store.unprocessed(id, 100).length });
      }
      if (body.action === 'repair') {
        const sample = body.sample;
        const draft = JSON.parse(jsonrepair(sample.output));
        const messages = consolidationMessages(consolidationCorrectionInput(sample.input, draft));
        messages.push({ role: 'user', content: [{ type: 'text', text: JSON.stringify({ draft, validationFeedback: sample.error }) }] });
        const estimatedTokens = messages.reduce((sum, message) => sum + tokens(message.content[0].text) + 8, tokens(consolidationInstructions));
        if (estimatedTokens > mind.config.budgets.consolidation) throw new Error('实际修正输入超过整理预算');
        const assembler = new BlockAssembler();
        const model = mind.models.effective(life.store.role(id));
        for await (const chunk of life.context.llm.stream({ provider: model.provider, model: model.model, reasoningEffort: 'off', system: consolidationInstructions, messages, signal: AbortSignal.timeout(120000) })) assembler.push(chunk);
        if (assembler.finish.kind !== 'stop') throw new Error(`修正没有完成：${assembler.finish.kind}`);
        const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
        const result = parseConsolidationOutput(consolidationSchema, text, sample.input);
        return send({ actualProductionFailure: true, schemaValid: true, estimatedTokens, withinBudget: true, originalOutputBytes: Buffer.byteLength(sample.output), correctionBytes: Buffer.byteLength(text), usage: assembler.usage, originalUsage: sample.originalUsage, format: 'business-object', saved: false, sourceOperationId: sample.operationId, memories: result.value.memories.length });
      }
      if (body.action === 'contexts') {
        if (body.ageWorld) {
          const source = life.store.memories(body.roleId, 100).find(memory => memory.kind === 'world').sources[0];
          for (let index = 0; index < 110; index++) life.store.saveMemory({ roleId: body.roleId, kind: 'episode', title: `后续档案${index}`, content: '独立的虚构档案资料。', realm: 'fictional', epistemic: 'fictional', people: [], aliases: [], sources: [source], archived: false, attention: 0.1 }, null, 'owner', '验证初始世界持续参与背景');
        }
        const values = [];
        for (const query of ['刚才提到的红楼梦阅读', '红楼梦中的人物处境', '之后继续讨论阅读进展']) values.push(JSON.parse(await mind.context(body.roleId ?? id, query)));
        return send(values);
      }
      if (body.action === 'stats') return send({ operations: life.store.operations(id, 200).filter(item => /^memory_(consolidate|query_expand)$/.test(item.tool)).map(item => ({ id: item.id, tool: item.tool, state: item.state, arguments: item.arguments, result: item.result })), pending: life.store.unprocessed(id, 100).length, memories: life.store.memories(id, 200).length });
      response.statusCode = 400; send({ error: '未知验收动作' });
    } catch (error) { response.statusCode = 500; send({ error: error.message }); }
  } }), 'auxiliary-cost-verification.route');
}
