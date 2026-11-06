import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './client';
import { databasePath } from './env';

const path = databasePath();
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
const ran = migrate(new Database(path));
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
