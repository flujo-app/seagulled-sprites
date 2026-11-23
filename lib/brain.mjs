// The thinking part. Talks to an AI model through a Fly connector:
// Ollama Cloud first, Google Gemini as a fallback. No API key ever lives on the Sprite.
import * as gw from './gateway.mjs';

const OLLAMA_PREFERENCE = (process.env.TODD_MODELS ?? 'gpt-oss:120b,kimi-k2.6,glm-5.3-flash,deepseek-v4.1-flash,gemma4,gpt-oss:20b')
  .split(',').map(s => s.trim()).filter(Boolean);

let chosen = null; // { provider, model }
export const usage = { calls: 0, inputTokens: 0, outputTokens: 0, provider: null, model: null };

async function ollamaModels() {
  try {
    const tags = await gw.json('ollama', '/api/tags');
    const names = (tags.models ?? []).map(m => m.name ?? m.model);
    const ordered = OLLAMA_PREFERENCE.flatMap(p => names.filter(n => n === p || n.startsWith(`${p}:`) || n.split(':')[0] === p));
    return [...new Set([...ordered, ...OLLAMA_PREFERENCE])];
  } catch {
    return OLLAMA_PREFERENCE;
  }
}

async function askOllama(model, messages, temperature) {
  const out = await gw.json('ollama', '/api/chat', { model, messages, stream: false, options: { temperature } }, { timeoutMs: 180_000 });
  usage.inputTokens += out.prompt_eval_count ?? 0;
  usage.outputTokens += out.eval_count ?? 0;
  return out.message?.content ?? '';
}

async function askGemini(model, messages, temperature) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const out = await gw.json('gemini', `/v1beta/models/${model}:generateContent`, {
    contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { temperature },
  }, { timeoutMs: 180_000 });
  usage.inputTokens += out.usageMetadata?.promptTokenCount ?? 0;
  usage.outputTokens += out.usageMetadata?.candidatesTokenCount ?? 0;
  return out.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
}

async function candidates() {
  const list = [];
  if (await gw.has('ollama')) for (const model of await ollamaModels()) list.push({ provider: 'ollama', model });
  if (await gw.has('gemini')) for (const model of (process.env.TODD_GEMINI_MODELS ?? 'gemini-2.5-flash,gemini-2.0-flash').split(',')) list.push({ provider: 'gemini', model: model.trim() });
  return list;
}

export async function available() {
  return (await gw.has('ollama')) || (await gw.has('gemini'));
}

export async function chat(messages, { temperature = 0.4 } = {}) {
  const tries = chosen ? [chosen, ...(await candidates()).filter(c => c.model !== chosen.model)] : await candidates();
  if (!tries.length) throw new Error('No AI model connector (Ollama or Gemini) is shared with this Sprite yet.');
  let lastError;
  for (const c of tries.slice(0, 6)) {
    try {
      const text = c.provider === 'ollama' ? await askOllama(c.model, messages, temperature) : await askGemini(c.model, messages, temperature);
      if (!text.trim()) throw new Error('empty answer');
      chosen = c;
      usage.calls += 1; usage.provider = c.provider; usage.model = c.model;
      return text;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Pull the first JSON object out of a model answer (models like to wrap it in prose or code fences).
export function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`no JSON in answer: ${text.slice(0, 200)}`);
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  throw new Error(`unfinished JSON in answer: ${text.slice(0, 200)}`);
}

export async function chatJson(messages, opts = {}) {
  let text = await chat(messages, opts);
  try { return extractJson(text); } catch (err) {
    text = await chat([...messages, { role: 'assistant', content: text }, { role: 'user', content: 'That was not valid JSON. Answer again with only the JSON object.' }], { temperature: 0 });
    return extractJson(text);
  }
}
