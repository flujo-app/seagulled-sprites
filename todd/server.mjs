// Todd. Lives in his own Sprite ("todd-boss"), sleeps when nobody needs him.
// You give him a goal; he asks HR for people, each one gets a brand-new Sprite,
// they do the work, Todd checks it, Jev rules on it, and everybody gets fired.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import * as gw from '../lib/gateway.mjs';
import * as brain from '../lib/brain.mjs';
import * as jev from '../lib/jev.mjs';
import * as memory from '../lib/memory.mjs';
import * as box from '../lib/box.mjs';

const HOME = '/home/sprite';
const DATA = path.join(HOME, 'todd-data');
const UI = path.join(path.dirname(new URL(import.meta.url).pathname), 'ui.html');
await mkdir(path.join(DATA, 'deliveries'), { recursive: true });
// Anyone may watch Todd's page; only someone with the passcode may give him work (work costs money).
const PASSCODE = (process.env.TODD_PASSCODE ?? await readFile(path.join(HOME, '.todd', 'passcode'), 'utf8').catch(() => '')).trim();

const PERSONA = `You are Todd, a manager in a small, slightly cursed company. You are busy, blunt, dryly funny and you only trust evidence.
You "seagull manage": you fly in, make noise, judge everything, and fly off. You are rude about work, never about people's identity; no slurs, nothing cruel. Short sentences.
You never claim work was done unless the evidence shows it. You never invent results.`;

const STATE_FILE = path.join(DATA, 'state.json');
const state = JSON.parse(await readFile(STATE_FILE, 'utf8').catch(() => '{"events":[],"goals":[]}'));
let saving = Promise.resolve();
const save = () => { saving = saving.then(() => writeFile(STATE_FILE, JSON.stringify(state))).catch(() => {}); return saving; };
let busy = null;
// A restart (or the Sprite waking from sleep) ends any goal that was running.
for (const g of state.goals) if (g.status === 'working') g.status = 'interrupted';

function say(kind, text, extra = {}) {
  const ev = { id: (state.events.at(-1)?.id ?? 0) + 1, at: new Date().toISOString(), kind, text, ...extra };
  state.events.push(ev);
  if (state.events.length > 1500) state.events.splice(0, state.events.length - 1500);
  save();
  slack.post(ev).catch(() => {});
  return ev;
}

// ---- HR, reached only through the "todd-hr" Custom API connector ----
const hr = {
  budget: () => gw.json('custom_api', '/budget', undefined, { name: 'todd-hr' }),
  hire: b => gw.json('custom_api', '/hire', b, { name: 'todd-hr' }),
  assign: b => gw.json('custom_api', '/assign', b, { name: 'todd-hr' }),
  job: (id, since) => gw.json('custom_api', `/jobs/${id}?since=${since}`, undefined, { name: 'todd-hr' }),
  fire: (worker, reason) => gw.json('custom_api', '/fire', { worker, reason }, { name: 'todd-hr' }),
  fireAll: () => gw.json('custom_api', '/fire-all', {}, { name: 'todd-hr' }),
};

// ---- Slack (optional): Todd posts the play-by-play and takes goals from one channel ----
const slack = {
  channel: process.env.TODD_SLACK_CHANNEL ?? null,
  lastTs: null,
  async post(ev) {
    if (!this.channel || !['todd', 'jev', 'hr', 'box'].includes(ev.kind) || !(await gw.has('slack_bot'))) return;
    await gw.json('slack_bot', '/chat.postMessage', { channel: this.channel, text: `${ev.kind === 'todd' ? '*Todd:* ' : `_${ev.kind}:_ `}${ev.text}`.slice(0, 3500) });
  },
  async listen() {
    if (!this.channel || process.env.TODD_SLACK_LISTEN !== '1' || !(await gw.has('slack_bot'))) return;
    const hist = await gw.json('slack_bot', `/conversations.history?channel=${encodeURIComponent(this.channel)}&limit=10${this.lastTs ? `&oldest=${this.lastTs}` : ''}`).catch(() => null);
    const msgs = (hist?.messages ?? []).filter(m => !m.bot_id && m.text).reverse();
    if (!this.lastTs) { this.lastTs = hist?.messages?.[0]?.ts ?? String(Date.now() / 1000); return; }
    for (const m of msgs) {
      this.lastTs = m.ts;
      const text = m.text.replace(/^\s*todd[,:]?\s*/i, '');
      if (/^\s*todd\b/i.test(m.text)) startGoal(text, 'slack');
    }
  },
};
setInterval(() => slack.listen().catch(() => {}), 20_000).unref();

// ---- the job ----
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function services() {
  const list = await gw.connections({ fresh: true }).catch(() => []);
  const on = p => list.some(c => c.provider === p);
  return {
    hr: list.some(c => c.provider === 'custom_api' && (c.display_name === 'todd-hr' || c.provider_account_name === 'todd-hr')),
    ollama: on('ollama'), gemini: on('gemini'), typesafe: on('typesafe'), pinecone: on('pinecone'), box: on('box'), slack: on('slack_bot'), github: on('github'),
  };
}

async function plan(goal, memories) {
  const recalled = memories.length ? memories.map(m => `- (${m.at?.slice(0, 10) ?? '?'}) ${m.text}`).join('\n') : 'Nothing. First time this comes up.';
  return brain.chatJson([
    { role: 'system', content: PERSONA },
    { role: 'user', content: `New goal from the boss:\n"""${goal}"""\n\nWhat you remember from earlier goals (Pinecone memory):\n${recalled}\n\nDecide how to staff it. You can hire 1 to 3 workers; each gets their own fresh Linux computer for at most ~10 minutes and about a dozen actions, so every assignment must be small, concrete and checkable (files to write, commands that prove it works). Split work so workers do not depend on each other. If the goal is just a question you can answer yourself, hire nobody.\n\nAnswer with only JSON:\n{"reply":"your first reaction to the boss, 1-3 short sentences, in character","title":"3-6 word title","team":[{"role":"developer|tester|writer|researcher|designer","nickname":"a made-up first name","task":"the exact assignment"}]}` },
  ], { temperature: 0.6 });
}

async function review(goal, member, result) {
  const files = (result?.files ?? []).map(f => f.content != null ? `--- ${f.name}\n${f.content.slice(0, 2500)}` : `--- ${f.name} (${f.skipped})`).join('\n').slice(0, 9000);
  const steps = (member.steps ?? []).map(e => e.kind === 'run' ? `$ ${e.command}` : e.kind === 'output' ? `  -> exit ${e.code}: ${String(e.tail ?? '').slice(-300)}` : e.kind === 'write' ? `wrote ${e.path}` : `${e.kind}: ${e.message ?? ''}`).join('\n').slice(-5000);
  return brain.chatJson([
    { role: 'system', content: PERSONA },
    { role: 'user', content: `Goal: ${goal}\nAssignment for ${member.nickname} (${member.role}): ${member.task}\n\nWhat they actually did (log):\n${steps || '(nothing logged)'}\n\nTheir own summary: ${result?.summary ?? '(none)'}\n\nFiles they handed in:\n${files || '(none)'}\n\nCheck the evidence, not the claims. Answer with only JSON:\n{"review":"2-4 sentences: what is really there and what is missing or unproven","roast":"one line straight to the worker, in character","feedback":"if it needs another pass: the exact fix; else empty","fate":"promote|keep|redo|fire"}` },
  ], { temperature: 0.5 });
}

async function flyOver(goal, team) {
  const latest = team.map(m => `${m.nickname}: ${(m.steps ?? []).slice(-3).map(e => e.kind === 'run' ? `ran "${e.command}"` : e.kind === 'write' ? `wrote ${e.path}` : e.kind).join(', ') || 'nothing yet'}`).join('\n');
  const out = await brain.chatJson([
    { role: 'system', content: PERSONA },
    { role: 'user', content: `You swoop over the team mid-work (goal: ${goal}). Latest activity:\n${latest}\nSay one or two cutting lines about what you see, then leave. Only JSON: {"say":"..."}` },
  ], { temperature: 0.9 });
  return out.say;
}

async function runMember(goal, member, onStep, feedback) {
  const { id } = await hr.assign({ worker: member.worker, goal, task: member.task, role: member.role, feedback, maxSteps: 12 });
  member.jobId = id;
  let since = 0;
  const deadline = Date.now() + 11 * 60_000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const job = await hr.job(id, since).catch(() => null);
    if (!job) continue;
    for (const ev of job.events) { member.steps.push(ev); onStep(member, ev); }
    since = job.eventCount;
    if (job.status !== 'working' && job.status !== 'starting') return job.result;
  }
  return { summary: 'Ran past the deadline. HR pulled the plug.', files: [] };
}

async function startGoal(text, from = 'web') {
  if (busy) { say('todd', 'One thing at a time. I am already busy failing upward on the last goal.'); return null; }
  const goal = { id: randomBytes(4).toString('hex'), text, from, status: 'working', startedAt: new Date().toISOString(), team: [] };
  state.goals.push(goal);
  say('user', text, { goalId: goal.id });
  busy = runGoal(goal).catch(err => {
    goal.status = 'failed';
    say('todd', `Well, that went sideways: ${String(err.message ?? err).slice(0, 300)}`, { goalId: goal.id });
  }).finally(async () => {
    busy = null;
    await hr.fireAll().catch(() => {});
    save();
  });
  return goal;
}

async function runGoal(goal) {
  const svc = await services();
  if (!svc.ollama && !svc.gemini) throw new Error('I have no brain connected. Somebody add the Ollama connector.');

  let memories = [];
  if (svc.pinecone) {
    memories = await memory.recall(goal.text).catch(err => { say('memory', `Memory is foggy (${String(err.message).slice(0, 120)}).`); return []; });
    const relevant = memories.filter(m => (m.score ?? 0) > 0.35);
    if (relevant.length) say('memory', `Todd remembers: ${relevant.map(m => m.text.slice(0, 160)).join(' / ')}`, { goalId: goal.id, data: relevant });
  }

  const p = await plan(goal.text, memories);
  goal.title = p.title ?? goal.text.slice(0, 40);
  say('todd', p.reply ?? 'Fine.', { goalId: goal.id });
  const team = (Array.isArray(p.team) ? p.team : []).slice(0, 3);
  if (!team.length) { goal.status = 'done'; return; }

  const budget = await hr.budget();
  say('hr', `Budget check: $${budget.spentUsd.toFixed(3)} of $${budget.capUsd} used. ${budget.onTheFloor.length} on the floor.`, { goalId: goal.id, data: budget });

  // Hire everyone at once: each hire is a brand-new Sprite.
  const hires = await Promise.allSettled(team.map(t => hr.hire({ role: t.role, nickname: t.nickname })));
  hires.forEach((h, i) => {
    const t = team[i];
    if (h.status === 'fulfilled') {
      goal.team.push({ ...t, worker: h.value.name, status: 'working', steps: [], round: 1 });
      say('hr', `Hired ${t.nickname} (${t.role}) into a fresh Sprite: ${h.value.name}.`, { goalId: goal.id, worker: h.value.name });
    } else {
      say('hr', `Could not hire ${t.nickname}: ${String(h.reason?.message ?? h.reason).slice(0, 200)}`, { goalId: goal.id });
    }
  });
  if (!goal.team.length) throw new Error('HR would not give me anybody.');
  save();

  const onStep = (m, ev) => {
    const text = ev.kind === 'write' ? `wrote ${ev.path}` : ev.kind === 'run' ? `$ ${ev.command}` : ev.kind === 'output' ? `exit ${ev.code}` : ev.kind === 'error' ? `stumbled: ${ev.message}` : ev.kind;
    say('worker', text, { goalId: goal.id, worker: m.worker, nickname: m.nickname, data: ev.kind === 'output' ? { code: ev.code, tail: String(ev.tail ?? '').slice(-400) } : ev.thought ? { thought: ev.thought } : undefined });
  };

  // Todd flies over once, while they work.
  const flyBy = sleep(70_000 + Math.random() * 40_000).then(async () => {
    if (goal.team.some(m => m.status === 'working')) say('todd', await flyOver(goal.text, goal.team).catch(() => 'Is anyone actually typing?'), { goalId: goal.id, flyover: true });
  });

  const results = await Promise.all(goal.team.map(async m => {
    let result = await runMember(goal.text, m, onStep);
    let r = await review(goal.text, m, result);
    let verdict = await (svc.typesafe ? jev.verdict({ goal: goal.text, task: m.task, report: JSON.stringify(result).slice(0, 6000), review: r.review }).catch(() => null) : null);
    let fate = verdict?.fate ?? r.fate ?? 'keep';
    say('todd', `${m.nickname}: ${r.roast ?? ''} ${r.review ?? ''}`.trim(), { goalId: goal.id, worker: m.worker });
    if (verdict) say('jev', `Jev on ${m.nickname}: ship ${(verdict.ship * 100).toFixed(0)}% likely. Verdict: ${fate}.`, { goalId: goal.id, worker: m.worker, data: verdict });
    if (fate === 'redo' && r.feedback) {
      m.round = 2;
      say('todd', `${m.nickname}, again. ${r.feedback}`, { goalId: goal.id, worker: m.worker });
      result = await runMember(goal.text, m, onStep, r.feedback);
      r = await review(goal.text, m, result);
      verdict = await (svc.typesafe ? jev.verdict({ goal: goal.text, task: m.task, report: JSON.stringify(result).slice(0, 6000), review: r.review }).catch(() => null) : null);
      fate = verdict?.fate === 'redo' ? 'keep' : (verdict?.fate ?? r.fate ?? 'keep');
      say('todd', `${m.nickname}, second try: ${r.roast ?? ''} ${r.review ?? ''}`.trim(), { goalId: goal.id, worker: m.worker });
      if (verdict) say('jev', `Jev on ${m.nickname}, round two: ship ${(verdict.ship * 100).toFixed(0)}% likely. Verdict: ${verdict.fate}.`, { goalId: goal.id, worker: m.worker, data: verdict });
    }
    m.status = fate; m.verdict = verdict; m.review = r; m.files = (result?.files ?? []).map(f => ({ name: f.name, skipped: f.skipped, bytes: f.content?.length ?? 0 }));
    const exit = fate === 'fire' ? 'You are fired.' : fate === 'promote' ? 'Excellent. You are promoted. Also fired, budget reasons.' : 'Fine. You are fired anyway, the Sprite costs money.';
    await hr.fire(m.worker, fate).catch(() => {});
    say('hr', `${m.nickname} (${m.worker}): ${exit} Sprite deleted.`, { goalId: goal.id, worker: m.worker, fired: true });
    return { m, result, fate };
  }));
  await flyBy.catch(() => {});

  // Ship what passed.
  const keep = results.filter(x => x.fate !== 'fire').flatMap(x => (x.result?.files ?? []).filter(f => f.content != null).map(f => ({ name: `${x.m.nickname}-${f.name}`.replace(/[\\/]/g, '_'), content: f.content })));
  const dir = path.join(DATA, 'deliveries', goal.id);
  await mkdir(dir, { recursive: true });
  for (const f of keep) await writeFile(path.join(dir, f.name), f.content);
  goal.files = keep.map(f => f.name);
  if (keep.length && svc.box) {
    try {
      goal.box = await box.deliver(goal.title, keep);
      say('box', `Filed ${keep.length} file(s) in Box, "Todd's Desk".${goal.box.folderUrl ? ` ${goal.box.folderUrl}` : ''}`, { goalId: goal.id, data: goal.box });
    } catch (err) { say('box', `Box refused the files: ${String(err.message).slice(0, 200)}`, { goalId: goal.id }); }
  }

  const wrap = await brain.chatJson([
    { role: 'system', content: PERSONA },
    { role: 'user', content: `Wrap up for the boss. Goal: ${goal.text}\nOutcome per worker:\n${results.map(x => `- ${x.m.nickname} (${x.m.role}): verdict ${x.fate}. ${x.m.review?.review ?? ''}`).join('\n')}\nFiles shipped: ${keep.map(f => f.name).join(', ') || 'none'}.\nBe honest about what is unproven. Only JSON: {"message":"3-5 short sentences, in character"}` },
  ], { temperature: 0.5 });
  say('todd', wrap.message, { goalId: goal.id, final: true });
  goal.status = 'done';
  goal.finishedAt = new Date().toISOString();

  if (svc.pinecone) {
    const line = `Goal "${goal.text.slice(0, 300)}" -> ${results.map(x => `${x.m.nickname} the ${x.m.role}: ${x.fate}${x.m.review?.feedback ? ` (needed: ${x.m.review.feedback.slice(0, 120)})` : ''}`).join('; ')}`;
    await memory.remember(`goal-${goal.id}`, line, { goal: goal.text.slice(0, 500), verdict: results.map(x => x.fate).join(','), at: goal.finishedAt })
      .then(() => say('memory', 'Filed under "things I will bring up later" (Pinecone).', { goalId: goal.id }))
      .catch(err => say('memory', `Could not file the memory: ${String(err.message).slice(0, 150)}`, { goalId: goal.id }));
  }
}

// ---- web ----
async function readBody(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 60_000) throw new Error('too long'); }
  return raw ? JSON.parse(raw) : {};
}

http.createServer(async (req, res) => {
  const send = (status, data, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
  try {
    const url = new URL(req.url, 'http://todd');
    if (url.pathname === '/' || url.pathname === '/index.html') return send(200, await readFile(UI, 'utf8'), 'text/html; charset=utf-8');
    if (url.pathname === '/api/state') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const [svc, budget] = await Promise.all([services(), hr.budget().catch(() => null)]);
      return send(200, { events: state.events.filter(e => e.id > since), goals: state.goals.slice(-10).map(g => ({ ...g, team: g.team.map(({ steps, ...m }) => ({ ...m, stepCount: steps?.length ?? 0 })) })), busy: Boolean(busy), services: svc, budget, model: brain.usage });
    }
    if (url.pathname === '/api/goal' && req.method === 'POST') {
      if (PASSCODE && req.headers['x-todd-passcode'] !== PASSCODE) return send(401, { error: 'Todd does not take orders from strangers.' });
      const { text } = await readBody(req);
      if (!text || String(text).length > 4000) return send(400, { error: 'Tell Todd something, 1-4000 characters.' });
      const g = await startGoal(String(text).trim());
      return send(g ? 202 : 409, g ? { id: g.id } : { error: 'busy' });
    }
    const f = url.pathname.match(/^\/files\/([a-f0-9]+)\/([^/]+)$/);
    if (f) return send(200, await readFile(path.join(DATA, 'deliveries', f[1], path.basename(decodeURIComponent(f[2]))), 'utf8'), 'text/plain; charset=utf-8');
    return send(404, { error: 'not here' });
  } catch (err) {
    return send(500, { error: String(err.message ?? err) });
  }
}).listen(8080, () => console.log('Todd is at his desk on 8080'));
