import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

if (process.versions.bun) throw new Error('构建脚本需要 Node.js');
const root = resolve(import.meta.dirname, '..');
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`构建失败：${args.join(' ')}`);
};

run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
for (const name of readdirSync(join(root, 'packages'))) {
  const sourceRoot = join(root, '.artifacts/tsc/packages', name, 'src');
  if (!existsSync(join(sourceRoot, 'index.js'))) continue;
  const destination = join(root, 'packages', name, 'lib');
  mkdirSync(join(destination, 'types'), { recursive: true });
  const entries = ['index', 'compaction', 'remote', 'typert', 'jobs'].map(name => join(sourceRoot, `${name}.js`)).filter(existsSync);
  await build({ entryPoints: entries, outdir: destination, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm', sourcemap: true });
  for (const file of readdirSync(sourceRoot, { recursive: true })) {
    if (typeof file === 'string' && file.endsWith('.d.ts')) {
      const target = join(destination, 'types', file);
      mkdirSync(resolve(target, '..'), { recursive: true });
      cpSync(join(sourceRoot, file), target);
    }
  }
}

if (existsSync(join(root, 'packages/kw-panel/src/client/index.tsx'))) {
  const id = '@kwagent/kw-panel';
  await build({
    entryPoints: [join(root, 'packages/kw-panel/src/client/index.tsx')], outfile: join(root, 'packages/kw-panel/lib/client.js'),
    bundle: true, platform: 'browser', target: 'es2022', format: 'cjs', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'zod', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'],
    loader: { '.css': 'text' },
    banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory(require){const module={exports:{}};const exports=module.exports;` },
    footer: { js: 'return module.exports;}});' },
  });
}
console.log('Host、类型声明和 Client 构建完成');
