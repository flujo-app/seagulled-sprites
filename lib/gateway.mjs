// Fly.io Sprites gateway: every outside service is reached through here.
// The calling Sprite never holds a key; Fly adds the credentials on the way out.
const GW = 'https://api.sprites.dev/v1/gateway';

let cache = null;
let cacheAt = 0;

export async function connections({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 60_000) return cache;
  const res = await fetch(`${GW}/list`);
  if (!res.ok) throw new Error(`gateway list failed: HTTP ${res.status}`);
  const body = await res.json();
  cache = body.connections ?? [];
  cacheAt = Date.now();
  return cache;
}

// Find a connection by provider slug (e.g. "ollama") or, for custom APIs, by its name.
export async function find(provider, name) {
  const list = await connections();
  return list.find(c => c.provider === provider && (!name || c.display_name === name || c.provider_account_name === name)) ?? null;
}

export async function has(provider, name) {
  return Boolean(await find(provider, name));
}

export async function base(provider, name) {
  const c = await find(provider, name);
  if (!c) throw new Error(`no ${name ?? provider} connector is shared with this Sprite`);
  return `${GW}/${provider}/${c.id}`;
}

export async function call(provider, path, init = {}, { name, timeoutMs = 120_000 } = {}) {
  const url = `${await base(provider, name)}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  return res;
}

export async function json(provider, path, body, opts = {}) {
  const init = body === undefined
    ? { method: opts.method ?? 'GET', headers: opts.headers }
    : { method: opts.method ?? 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(body) };
  const res = await call(provider, path, init, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider}${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
