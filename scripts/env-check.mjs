#!/usr/bin/env node
// Prints which PACT environment variables are set in .env.local, never their values.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envPath = resolve(root, '.env.local');
const examplePath = resolve(root, '.env.example');

const parse = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        const raw = l.slice(i + 1).replace(/\s+#.*$/, '').trim();
        return [l.slice(0, i).trim(), raw.replace(/^['"]|['"]$/g, '')];
      }),
  );

const names = Object.keys(parse(readFileSync(examplePath, 'utf8')));
const local = existsSync(envPath) ? parse(readFileSync(envPath, 'utf8')) : null;

console.log(local ? `.env.local found` : `.env.local NOT found (copy .env.example to .env.local)`);
for (const name of names) {
  const v = local?.[name] ?? process.env[name];
  console.log(`${name.padEnd(24)} ${v ? 'set' : 'not set'}`);
}
