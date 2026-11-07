import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Store, ModelPresets, modelPresetSchema, modelPresetWriteSchema, loadConfig, roleInputSchema, roleSchema, rememberSecret, redact, publicConfig, asJson } from '@kwagent/core';
import { imageGenerateSchema, imageEditSchema } from '@kwagent/kw-lagrange';

test('模型预设的用途、接口与图片参数严格校验', () => {
  const input = { id: 'images', name: '图片接口', kind: 'image', baseUrl: 'https://example.com/v1', model: 'custom-image', expectedRevision: null };
  assert.equal(modelPresetWriteSchema.parse(input).model, 'custom-image');
  assert.throws(() => modelPresetWriteSchema.parse({ ...input, baseUrl: 'https://user:secret@example.com/v1' }));
  assert.throws(() => modelPresetWriteSchema.parse({ ...input, baseUrl: 'https://example.com/v1?api_key=secret' }));
  assert.throws(() => modelPresetWriteSchema.parse({ ...input, apiKey: 'secret', clearApiKey: true }));
  assert.throws(() => modelPresetWriteSchema.parse({ ...input, apiKey: 'first\nsecond' }));
  assert.throws(() => modelPresetWriteSchema.parse({ ...input, headers: { Authorization: 'secret' } }));
  const chat = { id: 'official-flash', name: '官方 Flash', kind: 'chat', harnessProvider: 'deepseek-official', model: 'deepseek-flash', expectedRevision: null, reasoningEffort: 'high' };
  assert.equal(modelPresetWriteSchema.parse(chat).baseUrl, '');
  assert.throws(() => modelPresetWriteSchema.parse({ ...chat, apiKey: 'secret' }));
  assert.throws(() => modelPresetWriteSchema.parse({ ...chat, baseUrl: 'https://example.com/v1' }));
  assert.throws(() => modelPresetWriteSchema.parse({ ...chat, clearApiKey: true }));
  assert.throws(() => modelPresetWriteSchema.parse({ ...chat, kind: 'image' }));
  assert.throws(() => modelPresetWriteSchema.parse({ ...input, baseUrl: '' }));
  assert.equal(imageGenerateSchema.parse({ prompt: '真实图片请求描述', size: '1536x1024' }).size, '1536x1024');
  assert.throws(() => imageGenerateSchema.parse({ prompt: '', model: 'override' }));
  assert.throws(() => imageEditSchema.parse({ prompt: '调整画面', imageIds: [] }));
  assert.equal(imageEditSchema.parse({ prompt: '调整画面', imageIds: ['actual-media'], maskId: 'actual-mask' }).imageIds.length, 1);
});

test('Harness 聊天引用与思考等级独立保存，角色覆盖优先且不改写角色默认值', async () => {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID());
  const store = new Store(join(root, 'state.sqlite'));
  try {
    const models = new ModelPresets(new Context(), store, loadConfig({ KW_DATA_ROOT: root }));
    const preset = modelPresetSchema.parse({ id: 'official', kind: 'chat', name: '官方 Flash', harnessProvider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    store.put('model-preset', preset.id, null, asJson(preset), null, 'owner', '保存引用');
    const role = store.createRole(roleInputSchema.parse({ id: 'reader', accountId: 'main', name: '读取角色', initialPersona: '保留人格。', provider: 'deepseek-official', model: 'deepseek-flash', state: 'paused' }));
    const selected = models.selection({ ...role, chatPresetId: preset.id });
    assert.equal(selected.provider, 'deepseek-official'); assert.equal(selected.model, 'deepseek-flash'); assert.equal(selected.reasoningEffort, 'high');
    assert.equal(models.selection({ ...role, chatPresetId: preset.id, reasoningEffort: 'low' }).reasoningEffort, 'low');
    assert.equal(store.role(role.id).reasoningEffort, null);
    assert.equal(models.selection(role).reasoningEffort, null);
    assert.deepEqual(await models.remove(preset.id, preset.revision), { deleted: true });
    assert.equal(store.role(role.id).provider, 'deepseek-official');
    assert.equal(store.history('model-preset', preset.id).length, 2);
  } finally { store.close(); }
});

test('真实 SQLite 中的模型预设支持读取、角色用途隔离和旧角色兼容', () => {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID());
  const store = new Store(join(root, 'state.sqlite'));
  try {
    const models = new ModelPresets(new Context(), store, loadConfig({ KW_DATA_ROOT: root }));
    const preset = modelPresetSchema.parse({ id: 'chat', kind: 'chat', name: '自定义聊天', baseUrl: 'https://example.com/v1', model: 'actual-model-name', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    store.put('model-preset', preset.id, null, asJson(preset), null, 'owner', '测试预设');
    const role = store.createRole(roleInputSchema.parse({ id: 'reader', name: '读取角色', accountId: 'main', initialPersona: '独立角色', provider: 'legacy', model: 'legacy-model', state: 'paused' }));
    assert.equal(models.effective(role).provider, 'legacy');
    const selected = models.effective({ ...role, chatPresetId: preset.id });
    assert.equal(selected.provider, 'kw-preset-chat'); assert.equal(selected.model, preset.model);
    assert.equal(selected.state, 'paused'); assert.equal(selected.sessionId, role.sessionId);
    assert.throws(() => models.effective({ ...role, imagePresetId: preset.id }), /image 类型/);
    const { chatPresetId: _chat, visionPresetId: _vision, imagePresetId: _image, ...legacy } = role;
    assert.equal(roleSchema.parse(legacy).imagePresetId, null);
    assert.equal(store.history('model-preset', preset.id).length, 1);
  } finally { store.close(); }
});

test('生图配置与动态模型凭据始终脱敏', () => {
  assert.throws(() => loadConfig({ KW_IMAGE_MODEL: 'custom' }), /同时配置/);
  const config = loadConfig({ KW_IMAGE_BASE_URL: 'https://example.com/v1', KW_IMAGE_MODEL: 'custom', KW_IMAGE_API_KEY: 'image-local-secret' });
  rememberSecret('saved-model-secret');
  assert.equal(publicConfig(config).images.credentialConfigured, true);
  assert.ok(!JSON.stringify(publicConfig(config)).includes('image-local-secret'));
  assert.equal(redact('image-local-secret saved-model-secret', config), '[REDACTED] [REDACTED]');
});
