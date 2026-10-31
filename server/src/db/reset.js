/** 清空数据库并重新灌入种子数据 */
import fs from 'node:fs';
import { config } from '../config.js';

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const f = config.dbPath + suffix;
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    console.log('[reset] 已删除', f);
  }
}

const { seed } = await import('./seed.js');
await seed();
process.exit(0);
