import { writeFile } from 'node:fs/promises';
await writeFile(process.argv[2], '文件已经写入，工作进程未发送完成确认。');
process.kill(process.pid, 'SIGKILL');
