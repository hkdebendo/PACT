#!/usr/bin/env node
// Secret scan run before every commit. Fails if a staged (or, with --all, tracked) file contains
// a value from .env.local or a common credential pattern. Prints file:line and the rule, never
// the matched secret.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const all = process.argv.includes('--all');
const files = execSync(all ? 'git ls-files' : 'git diff --cached --name-only --diff-filter=ACM', {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => !/\.(png|jpe?g|gif|webp|ico|db|woff2?)$/i.test(f));

const secrets = [];
const envPath = resolve(root, '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    // Short or obviously non-secret values (URLs, modes, model ids, ports) are not checked.
    // Credentials are always checked, whatever their length; other values only when long enough
    // to be distinctive (URLs, modes, model ids and ports are not secrets).
    const sensitive = /(SECRET|PASSWORD|KEY|TOKEN|EMAIL|CLIENT_ID|WEBHOOK_ID)/.test(m[1]);
    if (!value || (!sensitive && (value.length < 12 || /^(https?:|file:)/.test(value))) || /^(MUSE_MODEL|LLM_MODE|PAYPAL_ENV|MUSE_REASONING_EFFORT)$/.test(m[1])) continue;
    if (sensitive && value.length < 4) continue;
    secrets.push({ name: m[1], value });
  }
}

const patterns = [
  ['PayPal access token', /A21AA[A-Za-z0-9_-]{40,}/],
  ['Bearer token literal', /Bearer\s+[A-Za-z0-9._-]{30,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['Generic sk- key', /\bsk-[A-Za-z0-9]{32,}/],
  ['AWS key', /AKIA[0-9A-Z]{16}/],
];

let failures = 0;
for (const file of files) {
  const path = resolve(root, file);
  if (!existsSync(path)) continue;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const { name, value } of secrets) {
      if (line.includes(value)) {
        console.error(`SECRET ${file}:${i + 1} contains the value of ${name}`);
        failures++;
      }
    }
    for (const [rule, re] of patterns) {
      if (re.test(line)) {
        console.error(`PATTERN ${file}:${i + 1} matches "${rule}"`);
        failures++;
      }
    }
  });
}

if (failures) {
  console.error(`secret-scan: ${failures} problem(s). Nothing should be committed.`);
  process.exit(1);
}
console.log(`secret-scan: ${files.length} file(s) clean (${secrets.length} env value(s) checked).`);
