import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
const response = await fetch(`${process.env.KW_CHAT_BASE_URL}/models`, {
  headers: { Authorization: `Bearer ${process.env.KW_CHAT_API_KEY}` },
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`模型目录请求失败：HTTP ${response.status}`);
const result = await response.json();
console.log(JSON.stringify(result.data?.map(model => ({ id: model.id, owned_by: model.owned_by })) ?? result, null, 2));
