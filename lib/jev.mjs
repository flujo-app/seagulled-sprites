// Jev (TypeSafe AI's "System One" model) makes Todd's typed calls:
// ship it or not, and what happens to each worker. It answers with probabilities, not prose.
import * as gw from './gateway.mjs';

export async function available() {
  return gw.has('typesafe');
}

export async function ask(state, questions) {
  const out = await gw.json('typesafe', '/v1/systemone', { model: process.env.TODD_JEV_MODEL ?? 'jev-latest', state, questions }, { timeoutMs: 60_000 });
  return { model: out.model, answers: out.answers ?? {} };
}

// One verdict per finished piece of work.
export async function verdict({ goal, task, report, review }) {
  const state = {
    goal,
    assignment: task,
    worker_report: String(report ?? '').slice(0, 6000),
    todd_review: String(review ?? '').slice(0, 3000),
  };
  const { model, answers } = await ask(state, {
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
  });
  return { model, ship: answers.ship?.noul ?? null, fate: answers.fate?.choice ?? null, fateProbabilities: answers.fate?.probabilities ?? null, confidence: answers.fate?.confidence ?? null };
}
