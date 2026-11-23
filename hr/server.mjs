// HR: the only part of the company allowed to hire. Lives in its own Sprite ("todd-hr").
// It holds the one hiring key (it can only create Sprites named todd-w-*, at most 3, and expires),
// keeps the budget, and fires anyone who overstays. Todd reaches HR through a Fly connector,
// so Todd never sees the hiring key or HR's door code.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { SpritesClient } from '@fly/sprites';

const HOME = '/home/sprite';
const HR_DIR = path.join(HOME, '.hr');
const APP = path.join(HOME, 'app');
const API = 'https://api.sprites.dev';
const HIRING_KEY = (await readFile(path.join(HR_DIR, 'hiring.token'), 'utf8')).trim();
const DOOR_CODE = (await readFile(path.join(HR_DIR, 'door.code'), 'utf8')).trim();
const client = new SpritesClient(HIRING_KEY, { timeout: 60_000 });

const CAP_USD = Number(process.env.HR_BUDGET_USD ?? 2.5);          // hard stop for estimated spend
const MAX_WORKERS = Number(process.env.HR_MAX_WORKERS ?? 1);         // Free plan: 3 Sprites in total, and Todd + HR are two of them
const MAX_MINUTES = Number(process.env.HR_MAX_MINUTES ?? 12);        // nobody stays longer than this
const MEMORY_MB = Number(process.env.HR_WORKER_MEMORY_MB ?? 2048);
// Upper-bound estimate per worker minute: 4 busy CPUs + 2 GB, at Sprites' published hourly prices.
const USD_PER_WORKER_MINUTE = (4 * 0.0385 + (MEMORY_MB / 1024) * 0.021875) / 60;

const STATE_FILE = path.join(HR_DIR, 'state.json');
const state = JSON.parse(await readFile(STATE_FILE, 'utf8').catch(() => '{"spentUsd":0,"workers":{},"hires":0,"fires":0}'));
const jobs = new Map();
const save = () => writeFile(STATE_FILE, JSON.stringify(state, null, 1)).catch(() => {});

function charge(worker) {
  const now = Date.now();
  const minutes = (now - (worker.billedUntil ?? worker.hiredAt)) / 60_000;
  worker.billedUntil = now;
  worker.costUsd = (worker.costUsd ?? 0) + minutes * USD_PER_WORKER_MINUTE;
  state.spentUsd += minutes * USD_PER_WORKER_MINUTE;
}

async function rest(method, url, body, headers = {}) {
  const res = await fetch(`${API}${url}`, { method, headers: { authorization: `Bearer ${HIRING_KEY}`, ...headers }, body });
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

const writeFileTo = (sprite, rel, content) =>
  rest('PUT', `/v1/sprites/${sprite}/fs/write?path=${encodeURIComponent(rel)}&workingDir=${encodeURIComponent(HOME)}&mkdir=true&mode=0644`, content, { 'content-type': 'application/octet-stream' });

const slug = s => String(s ?? 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14) || 'worker';
const alive = () => Object.values(state.workers).filter(w => !w.firedAt);

async function hire({ role = 'developer', nickname } = {}) {
  if (state.spentUsd >= CAP_USD) throw Object.assign(new Error(`Budget is spent ($${state.spentUsd.toFixed(3)} of $${CAP_USD}). HR says no.`), { status: 402 });
  if (alive().length >= MAX_WORKERS) throw Object.assign(new Error(`Already ${MAX_WORKERS} people on the floor. Fire someone first.`), { status: 409 });
  const name = `todd-w-${slug(role)}-${randomBytes(2).toString('hex')}`;
  await client.createSprite(name);
  await rest('POST', `/v1/sprites/${name}/policy/resources`, JSON.stringify({ memory: { limit_mb: MEMORY_MB } }), { 'content-type': 'application/json' }).catch(() => {});
  // Give the new hire the handbook: the worker program and the gateway helpers. No keys.
  for (const rel of ['lib/gateway.mjs', 'lib/brain.mjs', 'worker/agent.mjs']) {
    await writeFileTo(name, `team/${rel}`, await readFile(path.join(APP, rel)));
  }
  await writeFileTo(name, 'team/package.json', '{"type":"module"}');
  const worker = { name, role, nickname: nickname ?? null, hiredAt: Date.now() };
  state.workers[name] = worker;
  state.hires += 1;
  await save();
  return worker;
}

async function fire(name, reason = 'fired') {
  const worker = state.workers[name];
  if (!worker || worker.firedAt) return worker ?? null;
  for (const job of jobs.values()) if (job.worker === name && job.status === 'working') { job.cmd?.kill?.('SIGKILL'); job.status = 'stopped'; }
  charge(worker);
  await client.deleteSprite(name).catch(err => { worker.deleteError = String(err.message ?? err); });
  worker.firedAt = Date.now();
  worker.firedFor = reason;
  state.fires += 1;
  await save();
  return worker;
}

function assign({ worker, goal, task, role, feedback, maxSteps = 12 }) {
  const w = state.workers[worker];
  if (!w || w.firedAt) throw Object.assign(new Error(`${worker} does not work here.`), { status: 404 });
  const id = randomBytes(6).toString('hex');
  const job = { id, worker, task, status: 'starting', events: [], result: null, startedAt: Date.now() };
  jobs.set(id, job);
  (async () => {
    try {
      await writeFileTo(worker, 'job/task.json', JSON.stringify({ goal, task, role: role ?? w.role, feedback, maxSteps, workerName: w.nickname ?? worker }));
      const cmd = client.sprite(worker).spawn('node', ['team/worker/agent.mjs'], { cwd: HOME });
      job.cmd = cmd;
      job.status = 'working';
      let buffer = '';
      cmd.stdout.on('data', chunk => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
          if (!line.startsWith('@@')) continue;
          try {
            const ev = JSON.parse(line.slice(2));
            if (ev.kind === 'result') job.result = ev; else job.events.push(ev);
            if (job.events.length > 200) job.events.shift();
          } catch { /* ignore partial lines */ }
        }
      });
      let errTail = '';
      cmd.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-2000); });
      const code = await cmd.wait();
      job.exitCode = code;
      if (!job.result) job.result = { kind: 'result', summary: `Worker program stopped (exit ${code}). ${errTail.slice(-600)}`, files: [] };
      job.status = job.status === 'stopped' ? 'stopped' : 'done';
    } catch (err) {
      job.status = 'failed';
      job.result = { kind: 'result', summary: `HR could not run the job: ${String(err.message ?? err).slice(0, 400)}`, files: [] };
    }
    job.finishedAt = Date.now();
  })();
  return { id };
}

// Nobody overstays. Also clears out anyone left behind after a restart.
async function watchdog() {
  const now = Date.now();
  for (const w of alive()) {
    charge(w);
    if (now - w.hiredAt > MAX_MINUTES * 60_000) await fire(w.name, `overstayed ${MAX_MINUTES} minutes`);
  }
  try {
    const list = await client.listAllSprites('todd-w-');
    for (const s of list) {
      const known = state.workers[s.name];
      const created = Date.parse(s.created_at ?? s.createdAt ?? 0);
      if ((!known || known.firedAt) && now - created > 2 * 60_000) await client.deleteSprite(s.name).catch(() => {});
    }
  } catch { /* listing is best effort */ }
  await save();
}
setInterval(watchdog, 30_000).unref();
await watchdog();

const budget = () => ({
  spentUsd: Number(state.spentUsd.toFixed(4)), capUsd: CAP_USD, usdPerWorkerMinute: Number(USD_PER_WORKER_MINUTE.toFixed(5)),
  maxWorkers: MAX_WORKERS, maxMinutes: MAX_MINUTES, hires: state.hires, fires: state.fires,
  onTheFloor: alive().map(w => ({ name: w.name, role: w.role, nickname: w.nickname, minutes: Number(((Date.now() - w.hiredAt) / 60_000).toFixed(1)) })),
});

async function body(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 200_000) throw Object.assign(new Error('too big'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
}

http.createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, 'http://hr');
    if (url.pathname === '/health') return send(200, { ok: true });
    if (req.headers.authorization !== `Bearer ${DOOR_CODE}`) return send(401, { error: 'HR only talks to Todd.' });
    for (const w of alive()) charge(w);
    if (req.method === 'GET' && url.pathname === '/budget') return send(200, budget());
    if (req.method === 'POST' && url.pathname === '/hire') return send(201, await hire(await body(req)));
    if (req.method === 'POST' && url.pathname === '/assign') return send(202, assign(await body(req)));
    if (req.method === 'POST' && url.pathname === '/fire') { const b = await body(req); return send(200, await fire(b.worker, b.reason)); }
    if (req.method === 'POST' && url.pathname === '/fire-all') { const out = []; for (const w of alive()) out.push(await fire(w.name, 'end of shift')); return send(200, out); }
    const m = url.pathname.match(/^\/jobs\/([a-f0-9]+)$/);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      if (!job) return send(404, { error: 'no such job' });
      const since = Number(url.searchParams.get('since') ?? 0);
      return send(200, { id: job.id, worker: job.worker, status: job.status, events: job.events.slice(since), eventCount: job.events.length, result: job.status === 'working' ? null : job.result, exitCode: job.exitCode });
    }
    return send(404, { error: 'not here' });
  } catch (err) {
    return send(err.status ?? 500, { error: String(err.message ?? err) });
  }
}).listen(8080, () => console.log('HR is open on 8080'));
