// The thinking part. Talks to an AI model through a Fly connector, never with a key of its own.
// Order: Ollama Cloud (if the account has credits), then Google Gemini (has a free tier).
import * as gw from './gateway.mjs';

const OLLAMA_PREFERENCE = (process.env.TODD_MODELS ?? 'gpt-oss:120b,kimi-k2.6,glm-5.3-flash,deepseek-v4.1-flash,gemma4,gpt-oss:20b')
  .split(',').map(s => s.trim()).filter(Boolean);

let chosen = null; // { provider, model }
let ollamaBrokeUntil = 0; // Ollama answered "add credits": skip it for a while
const geminiCooldown = new Map(); // model -> time when it may be tried again
export const usage = { calls: 0, inputTokens: 0, outputTokens: 0, provider: null, model: null };
const sleep = ms => new Promise(r => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, text) { super(`HTTP ${status} ${text.slice(0, 300)}`); this.status = status; }
}

async function post(provider, path, body) {
  const res = await gw.call(provider, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { timeoutMs: 180_000 });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  return JSON.parse(text);
}

async function ollamaModels() {
  try {
    const tags = await gw.json('ollama', '/api/tags');
    const names = (tags.models ?? []).map(m => m.name ?? m.model);
    const ordered = OLLAMA_PREFERENCE.flatMap(p => names.filter(n => n === p || n.split(':')[0] === p));
    return [...new Set(ordered.length ? ordered : OLLAMA_PREFERENCE)];
  } catch {
    return OLLAMA_PREFERENCE;
  }
}

async function askOllama(model, messages, { temperature }) {
  const out = await post('ollama', '/api/chat', { model, messages, stream: false, options: { temperature } });
  usage.inputTokens += out.prompt_eval_count ?? 0;
  usage.outputTokens += out.eval_count ?? 0;
  return out.message?.content ?? '';
}

let geminiList = null;
async function geminiModels() {
  if (process.env.TODD_GEMINI_MODELS) return process.env.TODD_GEMINI_MODELS.split(',').map(s => s.trim());
  if (geminiList) return geminiList;
  try {
    const out = await gw.json('gemini', '/v1beta/models?pageSize=200');
    const usable = (out.models ?? [])
      .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /flash/.test(n) && !/(image|tts|audio|live|embedding|exp|preview-\d\d-\d\d)/.test(n));
    const version = n => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? 0);
    // Newest first; the full Flash before Flash-Lite of the same version.
    usable.sort((a, b) => version(b) - version(a) || Number(/lite/.test(a)) - Number(/lite/.test(b)) || a.length - b.length);
    geminiList = usable.length ? usable.slice(0, 6) : ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  } catch {
    geminiList = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  }
  return geminiList;
}

async function askGemini(model, messages, { temperature, json }) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const out = await post('gemini', `/v1beta/models/${model}:generateContent`, {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { temperature, maxOutputTokens: 8192, ...(json ? { responseMimeType: 'application/json' } : {}) },
  });
  usage.inputTokens += out.usageMetadata?.promptTokenCount ?? 0;
  usage.outputTokens += out.usageMetadata?.candidatesTokenCount ?? 0;
  return out.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? '';
}

async function candidates() {
  const list = [];
  if (Date.now() > ollamaBrokeUntil && await gw.has('ollama')) for (const model of await ollamaModels()) list.push({ provider: 'ollama', model });
  if (await gw.has('gemini')) for (const model of await geminiModels()) list.push({ provider: 'gemini', model });
  return list;
}

export async function available() {
  return (await gw.has('ollama')) || (await gw.has('gemini'));
}

export async function chat(messages, { temperature = 0.4, json = false } = {}) {
  let lastError = new Error('No AI model connector (Ollama or Gemini) is shared with this Sprite yet.');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const all = await candidates();
    const tries = chosen ? [chosen, ...all.filter(c => c.model !== chosen.model)] : all;
    for (const c of tries) {
      if (c.provider === 'gemini' && (geminiCooldown.get(c.model) ?? 0) > Date.now()) continue;
      try {
        const text = c.provider === 'ollama' ? await askOllama(c.model, messages, { temperature }) : await askGemini(c.model, messages, { temperature, json });
        if (!text.trim()) throw new Error('empty answer');
        chosen = c;
        usage.calls += 1; usage.provider = c.provider; usage.model = c.model;
        return text;
      } catch (err) {
        lastError = err;
        if (c.provider === 'ollama' && err.status === 402) { ollamaBrokeUntil = Date.now() + 10 * 60_000; break; } // no credits: stop trying Ollama models
        if (c.provider === 'gemini' && err.status === 429) geminiCooldown.set(c.model, Date.now() + 30_000); // free-tier rate limit: try another model
        if (c.provider === 'gemini' && err.status === 404) geminiCooldown.set(c.model, Date.now() + 3_600_000);
        if (chosen?.model === c.model) chosen = null;
      }
    }
    if (!(await available())) break;
    await sleep(8_000 * (attempt + 1)); // everyone was busy or rate-limited: wait and go round again
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
  let text = await chat(messages, { ...opts, json: true });
  try { return extractJson(text); } catch {
    text = await chat([...messages, { role: 'assistant', content: text }, { role: 'user', content: 'That was not valid JSON. Answer again with only the JSON object.' }], { temperature: 0, json: true });
    return extractJson(text);
  }
}
