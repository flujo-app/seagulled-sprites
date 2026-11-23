// Finished work lands in Box, in a folder called "Todd's Desk", one sub-folder per goal.
import * as gw from './gateway.mjs';

const ROOT_NAME = process.env.TODD_BOX_FOLDER ?? "Todd's Desk";
let rootId = null;

export async function available() {
  return gw.has('box');
}

async function folder(name, parentId) {
  const res = await gw.call('box', '/2.0/folders', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parent: { id: parentId } }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body.id;
  // Already there: Box tells us the id of the folder that clashes.
  const existing = body?.context_info?.conflicts?.[0]?.id ?? body?.context_info?.conflicts?.id;
  if (res.status === 409 && existing) return existing;
  throw new Error(`box folder "${name}": HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
}

// The Box connector speaks to api.box.com; uploads normally go to upload.box.com,
// so try the gateway path first and fall back to the upload host form if the gateway offers it.
async function upload(parentId, name, content) {
  const form = new FormData();
  form.append('attributes', JSON.stringify({ name, parent: { id: parentId } }));
  form.append('file', new Blob([content]), name);
  const paths = ['/api/2.0/files/content', '/2.0/files/content'];
  let last;
  for (const p of paths) {
    const res = await gw.call('box', p, { method: 'POST', body: form });
    if (res.ok) return (await res.json()).entries?.[0];
    last = `${p}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status !== 404 && res.status !== 405) break;
  }
  throw new Error(`box upload: ${last}`);
}

async function share(fileOrFolder, id) {
  const out = await gw.json('box', `/2.0/${fileOrFolder}/${id}?fields=shared_link`, { shared_link: { access: 'open' } }, { method: 'PUT' });
  return out.shared_link?.url ?? null;
}

// files: [{ name, content }] -> { folderUrl, files: [{ name, url }] }
export async function deliver(goalTitle, files) {
  rootId ??= await folder(ROOT_NAME, '0');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const safe = goalTitle.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'goal';
  const goalFolder = await folder(`${stamp} ${safe}`, rootId);
  const delivered = [];
  for (const f of files) {
    const entry = await upload(goalFolder, f.name.replace(/[\\/]/g, '_'), f.content);
    delivered.push({ name: f.name, id: entry?.id });
  }
  const folderUrl = await share('folders', goalFolder).catch(() => null);
  return { folderUrl, files: delivered };
}
