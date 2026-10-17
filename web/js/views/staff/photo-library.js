// The Photo library (owner, 17 Oct 2026: "also in another place where we will keep all our patients edited photos. the new photos you make
// should hane proper name and mr number along with the month of picture"): every patient's edited photos in one place. Search by name or
// Mr#, filter by city, branch, braces month, view and dates; open a photo full size; download it under its proper name
// ("Ayesha Khan - Mr# 50013 - Month 6 - Front - 17-10-2026.jpg"); select photos and download them as one zip with those names.
// Whoever opens patient profiles sees the edited photos; "View raw clinic photos folder" also the originals. The filters are kept in the
// address (#/staff/photo-library?q=50013&month=6).
import { h, mount, toast, friendlyError, modal, field, select, empty, busy, shortDate, announce, todayISO } from '../../ui/dom.js';
import { state, can, branchName } from '../../state.js';
import { VIEW_KEYS, viewName, downloadName, uniqueNames } from '../../lib/photo-intake.js';
import { zipParts } from '../../lib/zip.js';

const PAGE_SIZE = 120;
const ZIP_MAX_FILES = 300;
const ZIP_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
const FILTERS = ['q', 'city', 'branch', 'month', 'view', 'from', 'to', 'kind'];

export async function renderPhotoLibrary(root, params = new URLSearchParams(), signal) {
  document.title = 'Photo library | Clinic system';
  const d = state.data;
  const seesRaw = can('photos.view_raw');
  const f = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) || '']));
  if (f.kind !== 'raw' || !seesRaw) f.kind = 'edited';
  let rows = [];
  let total = 0;
  const selected = new Map(); // photo id -> row
  const links = new Map(); // path -> signed small copy

  const q = h('input', { type: 'search', value: f.q, placeholder: 'Name or Mr#', 'aria-label': 'Search by name or Mr#' });
  const citySel = select([{ value: '', label: 'All cities' }, ...state.ref.cities.map((c) => ({ value: c.id, label: c.name }))], f.city);
  const branchSel = select([{ value: '', label: 'All branches' }, ...state.ref.branches.map((b) => ({ value: b.id, label: b.name }))], f.branch);
  const monthIn = h('input', { type: 'number', min: '1', max: '60', value: f.month, inputmode: 'numeric', placeholder: 'Any' });
  const viewSel = select([{ value: '', label: 'Any view' }, ...VIEW_KEYS.map((k) => ({ value: k, label: viewName(k) }))], f.view);
  const fromIn = h('input', { type: 'date', value: f.from });
  const toIn = h('input', { type: 'date', value: f.to });
  const kindSel = seesRaw ? select([{ value: 'edited', label: 'Edited' }, { value: 'raw', label: 'Originals' }], f.kind) : null;
  const count = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const grid = h('div', { class: 'library-results' });
  const more = h('div', {});
  const bar = h('div', { class: 'inline library-bar' });

  const readFilters = () => {
    f.q = q.value.trim(); f.city = citySel.value; f.branch = branchSel.value; f.month = monthIn.value.trim(); f.view = viewSel.value;
    f.from = fromIn.value; f.to = toIn.value; f.kind = kindSel ? kindSel.value : 'edited';
    const qs = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && !(k === 'kind' && v === 'edited')));
    history.replaceState(null, '', `#/staff/photo-library${qs.toString() ? `?${qs}` : ''}`);
  };
  const query = (offset) => ({ q: f.q, cityId: f.city || null, branchId: f.branch || null, month: f.month || null, view: f.view || '', from: f.from || null, to: f.to || null,
    kind: f.kind, limit: PAGE_SIZE, offset });
  const properName = (row) => downloadName(row, { position: 1 });

  async function sign(list) {
    const paths = list.map((r) => r.thumb_path || r.storage_path).filter((p) => p && !links.has(p));
    if (!paths.length) return;
    try { const m = await d.signedUrls(paths, { width: 320 }); for (const [k, v] of m) links.set(k, v); } catch { /* tiles show without a picture */ }
  }
  function openPhoto(row) {
    const name = properName(row);
    const body = h('div', { class: 'inbox-lightbox' }, h('p', { class: 'muted' }, 'Loading the photo…'));
    const dlg = modal(name, body, [{ label: 'Close', primary: true }]);
    Promise.all([d.signedUrls([row.storage_path]), d.photoDownloadUrl(row.storage_path, name)]).then(([m, dl]) => {
      const src = m.get(row.storage_path);
      mount(body, src ? h('img', { src, alt: row.view_label || 'Photo' }) : h('p', {}, 'This photo cannot be shown just now.'),
        h('p', { class: 'library-name' }, name),
        h('div', { class: 'inline' },
          dl ? h('a', { class: 'btn btn-primary library-download', href: dl, download: name, rel: 'noopener' }, 'Download') : null,
          h('a', { class: 'btn', href: `#/staff/patient/${row.patient_id}`, onclick: () => dlg.close() }, 'Open patient file')));
    }).catch((e) => mount(body, h('p', {}, friendlyError(e))));
  }
  const groupKey = (r) => `${r.patient_id}|${r.taken_on}`;
  function draw() {
    const groups = new Map();
    for (const r of rows) { if (!groups.has(groupKey(r))) groups.set(groupKey(r), []); groups.get(groupKey(r)).push(r); }
    // (within one patient's day: in the order they were saved, the order of the sitting)
    for (const list of groups.values()) list.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    count.textContent = total ? `${total} photo${total === 1 ? '' : 's'}${rows.length < total ? `, ${rows.length} shown` : ''}.` : '';
    mount(grid, rows.length ? [...groups.values()].map((list) => {
      const r0 = list[0];
      const box = h('input', { type: 'checkbox', 'aria-label': `Select all ${list.length} photos of ${r0.full_name}, ${shortDate(r0.taken_on)}`, checked: list.every((r) => selected.has(r.id)),
        onchange: (e) => { for (const r of list) { if (e.target.checked) selected.set(r.id, r); else selected.delete(r.id); } draw(); } });
      return h('section', { class: 'library-group' },
        h('h3', {}, h('label', { class: 'inline' }, box,
          h('span', {}, [r0.full_name, `Mr# ${r0.mr_number}`, shortDate(r0.taken_on), r0.occasion || (r0.braces_month ? `Month ${r0.braces_month}` : null), r0.branch_id ? branchName(r0.branch_id) : null].filter(Boolean).join(' · ')))),
        h('div', { class: 'library-grid' }, list.map((r) => {
          const src = links.get(r.thumb_path || r.storage_path);
          return h('figure', { class: 'library-tile' },
            h('button', { type: 'button', class: 'library-open', 'aria-label': `Open ${properName(r)}`, onclick: () => openPhoto(r) },
              src ? h('img', { src, alt: '', loading: 'lazy' }) : h('span', { class: 'inbox-noprev' }, 'No preview')),
            h('figcaption', {}, h('label', { class: 'inline' },
              h('input', { type: 'checkbox', checked: selected.has(r.id), 'aria-label': `Select ${properName(r)}`, onchange: (e) => { if (e.target.checked) selected.set(r.id, r); else selected.delete(r.id); drawBar(); } }),
              h('span', {}, viewName(r.view_key) || r.view_label || 'Photo'))));
        })));
    }) : empty('No photos match.'));
    mount(more, rows.length < total ? h('button', { type: 'button', class: 'btn', onclick: busy(async () => {
      const r = await d.photoLibrary(query(rows.length));
      await sign(r.rows);
      rows = rows.concat(r.rows);
      total = r.total;
      draw();
    }) }, 'Show more') : null);
    drawBar();
  }
  function drawBar() {
    const n = selected.size;
    mount(bar,
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => { for (const r of rows) selected.set(r.id, r); draw(); } }, 'Select all shown'),
      n ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => { selected.clear(); draw(); } }, 'Clear the selection') : null,
      h('button', { type: 'button', class: 'btn btn-primary btn-small library-zip', disabled: !n, onclick: busy(downloadZip) }, n ? `Download selected (zip, ${n})` : 'Download selected (zip)'));
  }
  async function downloadZip() {
    const list = [...selected.values()];
    if (!list.length) return;
    if (list.length > ZIP_MAX_FILES) { toast(`Choose fewer photos: at most ${ZIP_MAX_FILES} in one zip.`, 'error'); return; }
    const names = uniqueNames(list.map(properName));
    const files = [];
    let bytes = 0;
    const progress = h('p', { role: 'status' });
    bar.append(progress);
    for (let i = 0; i < list.length; i++) {
      progress.textContent = `Adding ${i + 1} of ${list.length}`;
      if ((i + 1) % 10 === 0) announce(progress.textContent);
      const blob = await d.photoBlob(list[i].storage_path);
      bytes += blob.size;
      if (bytes > ZIP_MAX_BYTES) { progress.remove(); toast('Choose fewer photos: the zip would be larger than 1.5 GB.', 'error'); return; }
      files.push({ name: names[i], bytes: new Uint8Array(await blob.arrayBuffer()), date: new Date(`${list[i].taken_on}T12:00:00`) });
    }
    const patients = new Set(list.map((r) => r.patient_id));
    const zipName = patients.size === 1
      ? `${downloadName({ full_name: list[0].full_name, mr_number: list[0].mr_number, view_label: 'photos', taken_on: null }).replace(/\.jpg$/, '')}.zip`
      : `Clinic photos - ${todayISO().split('-').reverse().join('-')} - ${list.length} files.zip`;
    const url = URL.createObjectURL(new Blob(zipParts(files), { type: 'application/zip' }));
    const a = h('a', { href: url, download: zipName, class: 'library-zip-link', hidden: true });
    document.body.append(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
    progress.remove();
    toast(`${zipName} is saved (${list.length} photo${list.length === 1 ? '' : 's'}).`, 'ok');
  }
  async function search() {
    readFilters();
    selected.clear();
    mount(grid, h('p', { class: 'muted' }, 'Searching…'));
    try {
      const r = await d.photoLibrary(query(0));
      if (signal?.aborted) return;
      rows = r.rows;
      total = r.total;
      await sign(rows);
      draw();
    } catch (e) { mount(grid, h('div', { class: 'alert alert-warning', role: 'alert' }, friendlyError(e))); }
  }
  const form = h('form', { class: 'library-filters', onsubmit: (e) => { e.preventDefault(); search(); } },
    field('Search', q), field('City', citySel), field('Branch', branchSel), field('Month', monthIn), field('View', viewSel), field('From', fromIn), field('To', toIn),
    kindSel ? field('Show', kindSel) : null,
    h('div', { class: 'library-go' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search')));
  for (const el of [citySel, branchSel, viewSel, kindSel, fromIn, toIn].filter(Boolean)) el.addEventListener('change', search);
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Photo library'),
      h('p', { class: 'muted' }, 'Every patient\'s edited photos. Each photo downloads under its proper name: patient, Mr#, month, view and date.'))),
    h('div', { class: 'photo-library' }, form, count, bar, grid, more));
  await search();
}
