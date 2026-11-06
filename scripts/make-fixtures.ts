// npm run fixtures — generates neutral placeholder evidence images (no brands, no logos) by
// rendering SVG scenes in the locally installed Chrome. Vincent replaces the two product photos
// with real photos of a plain object (see HUMAN_TODO.md); re-record the LLM cache afterwards.
// Existing files are kept unless --force is passed, so real photos are never overwritten.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from '@pact/db';

const out = resolve(repoRoot, 'fixtures', 'evidence');
mkdirSync(out, { recursive: true });
const force = process.argv.includes('--force');

const W = 1200;
const H = 800;

// Deterministic pseudo-random so the images are byte-stable across runs.
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const table = `<rect width="${W}" height="${H}" fill="#c9a77c"/>${Array.from({ length: 14 }, (_, i) => `<rect y="${i * 60}" width="${W}" height="2" fill="#b38f62" opacity=".5"/>`).join('')}`;

function tshirt(x: number, y: number, s: number, star: boolean) {
  const d = `M${x - 30 * s},${y - 25 * s} l${18 * s},${-10 * s} q${12 * s},${10 * s} ${24 * s},0 l${18 * s},${10 * s} l${14 * s},${16 * s} l${-12 * s},${10 * s} l${-6 * s},${-6 * s} v${44 * s} h${-40 * s} v${-44 * s} l${-6 * s},${6 * s} l${-12 * s},${-10 * s} z`;
  const starPath = star
    ? `<polygon fill="#2557d6" points="${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map((i) => {
          const r = (i % 2 ? 2.4 : 6) * s;
          const a = (Math.PI / 5) * i - Math.PI / 2;
          return `${x + 10 * s + r * Math.cos(a)},${y - 10 * s + r * Math.sin(a)}`;
        })
        .join(' ')}"/>`
    : '';
  return `<path d="${d}" fill="#fbfbf8" stroke="#d8d6cf" stroke-width="1.5"/>${starPath}`;
}

function mug(x: number, y: number) {
  const c = ['#8f9aa3', '#6e7f8c', '#a3a9ad'][Math.floor(rnd() * 3)];
  return `<ellipse cx="${x}" cy="${y + 36}" rx="26" ry="7" fill="#00000022"/><rect x="${x - 24}" y="${y - 30}" width="48" height="64" rx="6" fill="${c}"/><ellipse cx="${x}" cy="${y - 30}" rx="24" ry="7" fill="#4b545b"/><path d="M${x + 24},${y - 14} q22,4 0,30" fill="none" stroke="${c}" stroke-width="8"/>`;
}

function tote(x: number, y: number) {
  return `<rect x="${x - 40}" y="${y - 30}" width="80" height="90" rx="4" fill="#efe6d2" stroke="#d6c8a8" stroke-width="2"/><path d="M${x - 20},${y - 30} q20,-40 40,0" fill="none" stroke="#d6c8a8" stroke-width="5"/>`;
}

const tag = (x: number, y: number, lines: string[]) =>
  `<g transform="rotate(-4 ${x} ${y})"><rect x="${x}" y="${y}" width="250" height="${30 + lines.length * 30}" fill="#fffdf4" stroke="#bbb"/>${lines
    .map((l, i) => `<text x="${x + 16}" y="${y + 38 + i * 30}" font-family="Courier New, monospace" font-size="22" fill="#222">${l}</text>`)
    .join('')}</g>`;

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;

const scenes: Record<string, { body: string; type: 'jpeg' | 'png' }> = {
  'order_conforming.jpg': {
    type: 'jpeg',
    body: svg(
      table +
        Array.from({ length: 50 }, (_, i) => tshirt(110 + (i % 10) * 98, 150 + Math.floor(i / 10) * 118, 1.15, true)).join('') +
        tag(880, 690, ['QTY: 50 PCS', 'WHITE / BLUE STAR']),
    ),
  },
  'order_wrong_item.jpg': {
    type: 'jpeg',
    body: svg(table + Array.from({ length: 24 }, (_, i) => mug(160 + (i % 8) * 125, 170 + Math.floor(i / 8) * 170)).join('') + tag(870, 700, ['QTY: 24 PCS', 'MUG / GREY'])),
  },
  'delivery_partial.jpg': {
    type: 'jpeg',
    body: svg(
      `<rect width="${W}" height="${H}" fill="#d9d4cc"/><rect x="180" y="120" width="840" height="560" fill="#b98d5b" stroke="#8e6a40" stroke-width="6"/><rect x="200" y="140" width="800" height="520" fill="#a47a4b"/>` +
        Array.from({ length: 12 }, (_, i) => tote(290 + (i % 6) * 125, 270 + Math.floor(i / 6) * 200)).join('') +
        tag(840, 690, ['DELIVERY BOX', 'TOTE BAGS']),
    ),
  },
  'tracking_valid.png': {
    type: 'png',
    body: svg(`
      <rect width="${W}" height="${H}" fill="#f4f6f8"/>
      <rect x="0" y="0" width="${W}" height="84" fill="#1f2a37"/>
      <text x="40" y="54" font-family="Arial, sans-serif" font-size="30" fill="#fff" font-weight="700">Courier tracking</text>
      <rect x="40" y="120" width="${W - 80}" height="620" rx="12" fill="#fff" stroke="#dde3ea"/>
      <text x="80" y="185" font-family="Arial" font-size="22" fill="#5b6774">Tracking number</text>
      <text x="80" y="225" font-family="Courier New, monospace" font-size="34" fill="#111" font-weight="700">PX 4815 1623 42</text>
      <rect x="760" y="160" width="340" height="70" rx="35" fill="#e3f6ea"/>
      <text x="930" y="206" text-anchor="middle" font-family="Arial" font-size="30" fill="#137a3a" font-weight="700">DELIVERED</text>
      <text x="80" y="300" font-family="Arial" font-size="22" fill="#5b6774">Contents: 1 parcel, 50 x t-shirt (white)</text>
      <text x="80" y="340" font-family="Arial" font-size="22" fill="#5b6774">Recipient: Ada — Cafe, front desk. Signed by: A. M.</text>
      ${['Delivered to recipient', 'Out for delivery', 'Arrived at local depot', 'Picked up from sender'].map((s, i) => `<circle cx="100" cy="${420 + i * 75}" r="12" fill="${i === 0 ? '#137a3a' : '#9aa5b1'}"/><text x="135" y="${428 + i * 75}" font-family="Arial" font-size="24" fill="#1f2a37">${s}</text>${i < 3 ? `<rect x="98" y="${434 + i * 75}" width="4" height="50" fill="#d0d6dc"/>` : ''}`).join('')}
    `),
  },
};

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
const page = await browser.newPage({ viewport: { width: W, height: H } });
for (const [name, s] of Object.entries(scenes)) {
  const path = resolve(out, name);
  if (existsSync(path) && !force) {
    console.log(`keep   ${name} (exists; --force to regenerate)`);
    continue;
  }
  await page.setContent(`<html><body style="margin:0">${s.body}</body></html>`);
  const buf = await page.screenshot({ type: s.type, ...(s.type === 'jpeg' && { quality: 88 }), clip: { x: 0, y: 0, width: W, height: H } });
  writeFileSync(path, buf);
  console.log(`wrote  ${name} (${buf.length} bytes)`);
}
writeFileSync(
  resolve(out, 'README.md'),
  `# Evidence fixtures\n\nNeutral, brand-free images for the demo scenario. Generated by \`npm run fixtures\` (placeholders) unless replaced by real photos.\n\n| File | Used for |\n|---|---|\n| order_conforming.jpg | production photo that matches the order (50 white t-shirts, blue star) |\n| order_wrong_item.jpg | wrong item (mugs) — the Verifier must reject it |\n| tracking_valid.png | courier tracking page showing "Delivered" |\n| delivery_partial.jpg | dispute variant: 12 of 20 tote bags |\n\nThe recorded model answers in \`fixtures/llm-cache/\` are keyed by the sha256 of these files: after replacing a file, re-record with a Meta key (\`LLM_MODE=live npm run demo\`).\n`,
);
await browser.close();
