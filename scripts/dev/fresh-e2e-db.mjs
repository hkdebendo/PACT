// Deletes the e2e SQLite database so each Playwright run starts clean.
import { rmSync } from 'node:fs';
for (const f of ['data/e2e.db', 'data/e2e.db-wal', 'data/e2e.db-shm']) rmSync(f, { force: true });
