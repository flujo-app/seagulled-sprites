// A worker on Todd's team. Runs inside its own throwaway Sprite (a full Linux computer),
// thinks through the AI model connector, and actually runs what it writes.
import { readFile, writeFile, mkdir, appendFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chatJson, usage } from '../lib/brain.mjs';

const HOME = '/home/sprite';
const WORK = path.join(HOME, 'work');
const JOB = path.join(HOME, 'job');
const job = JSON.parse(await readFile(path.join(JOB, 'task.json'), 'utf8'));
const MAX_STEPS = Math.min(job.maxSteps ?? 12, 20);
await mkdir(WORK, { recursive: true });

function emit(kind, data) {
  const line = JSON.stringify({ kind, at: new Date().toISOString(), ...data });
  process.stdout.write(`@@${line}\n`);
  return appendFile(path.join(JOB, 'log.jsonl'), `${line}\n`).catch(() => {});
}

function run(command, timeoutMs = 90_000) {
  return new Promise(resolve => {
    const child = spawn('bash', ['-lc', command], { cwd: WORK, env: { ...process.env, CI: '1' } });
    let out = '';
    const add = d => { out += d; if (out.length > 60_000) out = out.slice(-60_000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { out += `\n[stopped after ${timeoutMs / 1000}s]`; child.kill('SIGKILL'); }, timeoutMs);
    // The Sprite's .bashrc warns about line editing on every login shell: noise, not output.
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.replace(/^.*bind: warning: line editing not enabled\r?\n?/gm, '') }); });
  });
}

const system = `You are ${job.workerName}, a ${job.role} on Todd's team. Todd is a blunt manager who checks real evidence and fires people for claims without proof.
You are alone inside your own Linux computer (Ubuntu, Node.js 24, Python 3.13, git, curl, internet access). Your working folder is ${WORK}.
Answer every turn with exactly ONE JSON object and nothing else, one of:
{"thought":"short reason","action":"write","path":"relative/file/path","content":"full file content"}
{"thought":"short reason","action":"run","command":"bash command (runs in ${WORK}, 90 s limit)"}
{"thought":"short reason","action":"done","summary":"what you made, how you checked it, what is still missing","deliverables":["relative/path", "..."]}
Rules: keep files small and focused. Run what you write to prove it works (tests, a sample run, node --check, python -m py_compile). Never claim something you did not run. You have at most ${MAX_STEPS} actions, so finish with "done" in time, honestly listing gaps.`;

const messages = [
  { role: 'system', content: system },
  { role: 'user', content: `The whole goal (Todd's boss asked for it): ${job.goal}\n\nYOUR assignment: ${job.task}${job.feedback ? `\n\nTodd's feedback on your last attempt (fix this):\n${job.feedback}` : ''}\n\nStart.` },
];

let result = null;
for (let step = 1; step <= MAX_STEPS && !result; step += 1) {
  let action;
  try {
    action = await chatJson(messages, { temperature: 0.2 });
  } catch (err) {
    await emit('error', { step, message: String(err.message ?? err).slice(0, 400) });
    if (step >= 3) break;
    continue;
  }
  messages.push({ role: 'assistant', content: JSON.stringify(action) });
  if (action.action === 'write' && action.path) {
    const target = path.resolve(WORK, action.path);
    if (!target.startsWith(WORK)) { messages.push({ role: 'user', content: 'Path must stay inside the working folder.' }); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(action.content ?? ''));
    await emit('write', { step, thought: action.thought, path: action.path, bytes: Buffer.byteLength(String(action.content ?? '')) });
    messages.push({ role: 'user', content: `Wrote ${action.path}. Next action.` });
  } else if (action.action === 'run' && action.command) {
    await emit('run', { step, thought: action.thought, command: String(action.command).slice(0, 500) });
    const { code, out } = await run(String(action.command));
    await emit('output', { step, code, tail: out.slice(-1500) });
    messages.push({ role: 'user', content: `Exit code ${code}. Output (last part):\n${out.slice(-6000)}\nNext action.` });
  } else if (action.action === 'done') {
    result = { summary: String(action.summary ?? ''), deliverables: Array.isArray(action.deliverables) ? action.deliverables : [] };
  } else {
    messages.push({ role: 'user', content: 'Unknown action. Use write, run or done.' });
  }
  if (step === MAX_STEPS - 1 && !result) messages.push({ role: 'user', content: 'Last action left: finish with "done" now.' });
}
result ??= { summary: 'Ran out of steps before finishing.', deliverables: [] };

// Hand back the files (text only, size-capped). Binary files are listed, not sent.
async function collect(list) {
  const files = [];
  let total = 0;
  const wanted = list.length ? list : (await readdir(WORK, { recursive: true }).catch(() => [])).filter(f => !f.includes('node_modules') && !f.startsWith('.'));
  for (const rel of wanted.slice(0, 25)) {
    const full = path.resolve(WORK, String(rel));
    if (!full.startsWith(WORK)) continue;
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    const buf = await readFile(full);
    const text = buf.toString('utf8');
    const binary = text.includes('�') || buf.includes(0);
    if (binary || info.size > 200_000 || total + info.size > 1_000_000) { files.push({ name: String(rel), skipped: binary ? 'binary' : 'too large' }); continue; }
    total += info.size;
    files.push({ name: String(rel), content: text });
  }
  return files;
}

const files = await collect(result.deliverables);
await emit('result', { summary: result.summary, files, usage });
