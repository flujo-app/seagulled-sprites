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

// Uploads go to Box's upload host; the Fly gateway maps that to /upload/... ("attributes" must come before "file").
async function upload(parentId, name, content) {
  const form = new FormData();
  form.append('attributes', JSON.stringify({ name, parent: { id: parentId } }));
  form.append('file', new Blob([content]), name);
  const res = await gw.call('box', '/upload/files/content', { method: 'POST', body: form });
  if (res.ok) return (await res.json()).entries?.[0];
  throw new Error(`box upload: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
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
  // The Fly Box connector does not offer shared links, so point the owner at the folder in Box's web app.
  const folderUrl = await share('folders', goalFolder).catch(() => `https://app.box.com/folder/${goalFolder}`);
  return { folderUrl, files: delivered };
}
