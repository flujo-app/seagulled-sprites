#!/usr/bin/env node
// Puts Todd and HR into their Sprites. Run from your own computer:
//   SPRITES_TOKEN=... HIRING_TOKEN=... node deploy/deploy.mjs
// SPRITES_TOKEN: a token that may manage Sprites named "todd*".
// HIRING_TOKEN:  a token limited to Sprites named "todd-w" (max 3). It goes to HR only.
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const API = 'https://api.sprites.dev';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const TOKEN = process.env.SPRITES_TOKEN;
const HIRING = process.env.HIRING_TOKEN;
const DOOR = process.env.HR_DOOR_CODE ?? randomBytes(24).toString('hex');
if (!TOKEN || !HIRING) { console.error('Set SPRITES_TOKEN and HIRING_TOKEN.'); process.exit(1); }
const BOSS = process.env.TODD_SPRITE ?? 'todd-boss';
const HR = process.env.HR_SPRITE ?? 'todd-hr';

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${API}${url}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text;
}
const apiJson = (m, u, b) => api(m, u, b === undefined ? undefined : JSON.stringify(b), { 'content-type': 'application/json' });

async function ensureSprite(name) {
  const res = await fetch(`${API}/v1/sprites/${name}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (res.ok) return JSON.parse(await res.text());
  return JSON.parse(await apiJson('POST', '/v1/sprites', { name }));
}

async function put(name, rel, content, mode = '0644') {
  await api('PUT', `/v1/sprites/${name}/fs/write?path=${encodeURIComponent(rel)}&workingDir=/home/sprite&mkdir=true&mode=${mode}`, content, { 'content-type': 'application/octet-stream' });
}

// The HTTP exec answer is framed: 0x01 stdout, 0x02 stderr, 0x03 <exit code>. Good enough for short commands.
async function sh(name, command) {
  const q = new URLSearchParams();
  for (const c of ['bash', '-lc', command]) q.append('cmd', c);
  const res = await fetch(`${API}/v1/sprites/${name}/exec?${q}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  const exit = buf.length >= 2 && buf[buf.length - 2] === 3 ? buf[buf.length - 1] : null;
  const out = buf.subarray(0, exit === null ? buf.length : buf.length - 2).toString('utf8').replace(/[\x01\x02]/g, '');
  if (!res.ok || (exit !== null && exit !== 0)) throw new Error(`${name}$ ${command}\n${out.slice(-1500)}\n(exit ${exit ?? res.status})`);
  return out;
}

async function files(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(rel)); else out.push(rel);
  }
  return out;
}

async function upload(name, dirs) {
  const list = ['package.json', ...(await Promise.all(dirs.map(files))).flat()];
  for (const rel of list) await put(name, `app/${rel}`, await readFile(path.join(ROOT, rel)));
  console.log(`  ${name}: uploaded ${list.length} files`);
}

async function service(name, svc, script) {
  await apiJson('PUT', `/v1/sprites/${name}/services/${svc}`, { cmd: 'node', args: [script], needs: [], dir: '/home/sprite/app', http_port: 8080 });
  await sh(name, `sprite-env services restart ${svc} >/dev/null 2>&1 || sprite-env services start ${svc} >/dev/null 2>&1 || true`);
}

console.log('Sprites:');
const boss = await ensureSprite(BOSS);
const hr = await ensureSprite(HR);
console.log(`  ${BOSS}: ${boss.url}\n  ${HR}: ${hr.url}`);

console.log('HR:');
await upload(HR, ['lib', 'hr', 'worker']);
await put(HR, '.hr/hiring.token', HIRING, '0600');
await put(HR, '.hr/door.code', DOOR, '0600');
await sh(HR, 'cd ~/app && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2');
await service(HR, 'hr', 'hr/server.mjs');
await apiJson('PUT', `/v1/sprites/${HR}`, { url_settings: { auth: 'public' } });

console.log('Todd:');
await upload(BOSS, ['lib', 'todd']);
await service(BOSS, 'todd', 'todd/server.mjs');

console.log('\nDone.');
console.log(`Todd (private, sign in with your Fly account): ${boss.url}`);
console.log(`HR door (public, needs the door code): ${hr.url}`);
if (!process.env.HR_DOOR_CODE) console.log(`\nNew HR door code (put it into the "todd-hr" Custom API connector as the token):\n${DOOR}`);
