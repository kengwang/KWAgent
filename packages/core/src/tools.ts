import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext, ToolOutputDefinition } from '@deepseek-ai/dsh-tools';
import { asJson, jsonSchema } from './types.ts';

/** 模型输入经过 Zod 校验，输出采用 Harness 的正式工具结果路径。 */
export function registerTool<T>(ctx: Context, name: string, description: string, schema: z.ZodType<T>, execute: (input: T, exec: ToolRunContext) => Promise<unknown>, render?: ToolOutputDefinition['render']): void {
  const parameters = z.record(z.string(), jsonSchema).parse(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
  const tool: ToolDefinition = {
    name, description, parameters,
    output: { schema: {}, render: render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value) }]) },
    execute: async (args, exec) => asJson(await execute(schema.parse(args), exec)),
  };
  ctx.tools.register(tool);
}
