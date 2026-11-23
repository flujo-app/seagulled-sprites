// Todd's long memory lives in Pinecone: every goal, verdict and grudge, searchable by meaning.
// Pinecone turns the text into vectors itself (integrated embedding), so no embedding model runs here.
import * as gw from './gateway.mjs';

const INDEX = process.env.TODD_MEMORY_INDEX ?? 'todd-memory';
const NAMESPACE = 'office';
const HEADERS = { 'X-Pinecone-Api-Version': '2025-10' };
let ready = false;

export async function available() {
  return gw.has('pinecone');
}

async function ensureIndex() {
  if (ready) return;
  const res = await gw.call('pinecone', `/indexes/${INDEX}`, { headers: HEADERS });
  if (res.status === 404) {
    await gw.json('pinecone', '/indexes/create-for-model', {
      name: INDEX, cloud: 'aws', region: 'us-east-1',
      embed: { model: 'llama-text-embed-v2', field_map: { text: 'text' } },
    }, { headers: HEADERS });
    // A fresh serverless index takes a few seconds before it accepts writes.
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

export async function remember(id, text, fields = {}) {
  await ensureIndex();
  const record = { _id: id, text: String(text).slice(0, 8000), ...fields };
  const res = await gw.call('pinecone', `/indexes/${INDEX}/records/namespaces/${NAMESPACE}/upsert`, {
    method: 'POST', headers: { ...HEADERS, 'content-type': 'application/x-ndjson' }, body: `${JSON.stringify(record)}\n`,
  });
  if (!res.ok) throw new Error(`pinecone upsert: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function recall(text, topK = 3) {
  await ensureIndex();
  const out = await gw.json('pinecone', `/indexes/${INDEX}/records/namespaces/${NAMESPACE}/search`, {
    query: { inputs: { text: String(text).slice(0, 2000) }, top_k: topK },
    fields: ['text', 'goal', 'verdict', 'at'],
  }, { headers: HEADERS });
  return (out.result?.hits ?? []).map(h => ({ id: h._id, score: h._score, ...h.fields }));
}
