// Todd's long memory: every goal, verdict and grudge.
// With the Pinecone connector it is searched by meaning (Pinecone embeds the text itself).
// Without it, Todd keeps a notebook on his own Sprite's disk (Sprites keep their files) and searches by words.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as gw from './gateway.mjs';

const INDEX = process.env.TODD_MEMORY_INDEX ?? 'todd-memory';
const NAMESPACE = 'office';
const HEADERS = { 'X-Pinecone-Api-Version': '2025-10' };
const NOTEBOOK = path.join(process.env.HOME ?? '/home/sprite', 'todd-data', 'memory.json');
let ready = false;

export async function backend() {
  return (await gw.has('pinecone')) ? 'pinecone' : 'notebook';
}

async function ensureIndex() {
  if (ready) return;
  const res = await gw.call('pinecone', `/indexes/${INDEX}`, { headers: HEADERS });
  if (res.status === 404) {
    await gw.json('pinecone', '/indexes/create-for-model', {
      name: INDEX, cloud: 'aws', region: 'us-east-1',
      embed: { model: 'llama-text-embed-v2', field_map: { text: 'text' } },
    }, { headers: HEADERS });
    for (let i = 0; i < 30; i += 1) {
      const d = await gw.json('pinecone', `/indexes/${INDEX}`, undefined, { headers: HEADERS }).catch(() => null);
      if (d?.status?.ready) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  } else if (!res.ok) {
    throw new Error(`pinecone index check: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  ready = true;
}

const words = s => new Set(String(s).toLowerCase().match(/[a-z0-9äöüß]{3,}/g) ?? []);
async function notebook() { return JSON.parse(await readFile(NOTEBOOK, 'utf8').catch(() => '[]')); }

export async function remember(id, text, fields = {}) {
  if (await backend() === 'pinecone') {
    await ensureIndex();
    const record = { _id: id, text: String(text).slice(0, 8000), ...fields };
    const res = await gw.call('pinecone', `/indexes/${INDEX}/records/namespaces/${NAMESPACE}/upsert`, {
      method: 'POST', headers: { ...HEADERS, 'content-type': 'application/x-ndjson' }, body: `${JSON.stringify(record)}\n`,
    });
    if (!res.ok) throw new Error(`pinecone upsert: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return 'pinecone';
  }
  const book = (await notebook()).filter(r => r.id !== id);
  book.push({ id, text: String(text).slice(0, 4000), ...fields });
  await mkdir(path.dirname(NOTEBOOK), { recursive: true });
  await writeFile(NOTEBOOK, JSON.stringify(book.slice(-500)));
  return 'notebook';
}

export async function recall(text, topK = 3) {
  if (await backend() === 'pinecone') {
    await ensureIndex();
    const out = await gw.json('pinecone', `/indexes/${INDEX}/records/namespaces/${NAMESPACE}/search`, {
      query: { inputs: { text: String(text).slice(0, 2000) }, top_k: topK },
      fields: ['text', 'goal', 'verdict', 'at'],
    }, { headers: HEADERS });
    return (out.result?.hits ?? []).map(h => ({ id: h._id, score: h._score, ...h.fields }));
  }
  const q = words(text);
  return (await notebook())
    .map(r => { const w = words(r.text); const shared = [...q].filter(x => w.has(x)).length; return { ...r, score: shared / Math.max(1, Math.min(q.size, w.size)) }; })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
