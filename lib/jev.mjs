// Typed verdicts. With the TypeSafe connector this is Jev, TypeSafe AI's "System One" decision model:
// it answers yes/no and pick-one questions with probabilities, not prose.
// Without it, a stand-in asks Todd's own brain the very same typed questions, and says so.
import * as gw from './gateway.mjs';
import { chatJson } from './brain.mjs';

export async function available() {
  return gw.has('typesafe');
}

const QUESTIONS = {
  ship: {
    type: 'noul',
    instructions: 'Does the worker report show finished, working output that meets the assignment, backed by evidence (files written, commands run, results shown)?',
    criteria: { true: 'Finished and shown to work', false: 'Unfinished, broken, or only claimed without evidence' },
  },
  fate: {
    type: 'choice',
    instructions: 'What should the manager do with this worker now?',
    criteria: {
      promote: 'Excellent work, clearly better than asked',
      keep: 'Acceptable work, ship it',
      redo: 'Close, but needs one more corrective pass',
      fire: 'Poor work or nothing useful delivered',
    },
  },
};

async function askJev(state) {
  const out = await gw.json('typesafe', '/v1/systemone', { model: process.env.TODD_JEV_MODEL ?? 'jev-latest', state, questions: QUESTIONS }, { timeoutMs: 60_000 });
  const a = out.answers ?? {};
  return { judge: 'jev', model: out.model, ship: a.ship?.noul ?? null, fate: a.fate?.choice ?? null, fateProbabilities: a.fate?.probabilities ?? null, confidence: a.fate?.confidence ?? null };
}

async function askStandIn(state) {
  const out = await chatJson([
    { role: 'system', content: 'You are a strict, calibrated judge. You answer typed questions with probabilities only. No prose.' },
    { role: 'user', content: `STATE:\n${JSON.stringify(state)}\n\nQUESTIONS:\n${JSON.stringify(QUESTIONS)}\n\nAnswer with only JSON: {"ship": <probability 0..1 that the answer to "ship" is true>, "fate": {"promote": p, "keep": p, "redo": p, "fire": p}} where the four fate probabilities sum to 1.` },
  ], { temperature: 0 });
  const raw = Object.fromEntries(Object.keys(QUESTIONS.fate.criteria).map(k => [k, Math.max(0, Number(out.fate?.[k]) || 0)]));
  const total = Object.values(raw).reduce((s, v) => s + v, 0) || 1;
  const probs = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / total]));
  const [fate, top] = Object.entries(probs).sort((x, y) => y[1] - x[1])[0];
  return { judge: 'stand-in', model: "Todd's brain, Jev's question format", ship: Math.min(1, Math.max(0, Number(out.ship) || 0)), fate, fateProbabilities: probs, confidence: top };
}

// One verdict per finished piece of work.
export async function verdict({ goal, task, report, review }) {
  const state = { goal, assignment: task, worker_report: String(report ?? '').slice(0, 6000), todd_review: String(review ?? '').slice(0, 3000) };
  if (await available()) {
    try { return await askJev(state); } catch (err) { /* fall through to the stand-in */ }
  }
  return askStandIn(state);
}
