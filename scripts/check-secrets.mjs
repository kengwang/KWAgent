import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
if (existsSync('.env')) loadEnvFile('.env');
const secrets = Object.entries(process.env).filter(([name, value]) => /(?:API_KEY|ACCESS_TOKEN)$/.test(name) && value && value.length >= 12).map(([, value]) => value);
const listing = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
if (listing.status !== 0) throw new Error('无法读取 Git 文件清单');
for (const file of listing.stdout.split('\0').filter(Boolean)) {
  const content = readFileSync(file, 'utf8');
  if (secrets.some(secret => content.includes(secret))) throw new Error(`文件包含实际凭据：${file}`);
}
const ignored = spawnSync('git', ['check-ignore', '.env'], { encoding: 'utf8' });
if (existsSync('.env') && ignored.status !== 0) throw new Error('.env 没有被 Git 排除');
console.log('Git 文件凭据检查通过');
