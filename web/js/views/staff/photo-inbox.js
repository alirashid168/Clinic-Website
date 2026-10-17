// The Photo inbox (owner, 17 Oct 2026): staff take photos all day and, after the last patient, upload them all at once into the city
// folder (Karachi, Lahore, Islamabad). The page reads each photo's camera time, stores the original as it is (kept for good), matches the
// whole day's photos to the patients on the city's Aaj ki List by time (lib/photo-intake.js planDay; the database checks the plan again),
// files the clear ones by itself and asks "Which patient?" for the rest: one tap. While the page is open it also edits the photos with
// Claude (photo-ai Edge Function for the numbers, the canvas here for the pixels); without the AI key the photos wait, already filed.
// Tabs: Upload · Which patient? · Filed · Set aside. Who may: "Use the Photo inbox" and "View raw clinic photos folder" (shell.js);
// moving and undoing a filing: "Delete clinic photos and X-rays". docs/PHOTO-INTAKE.md explains it to staff.
import { h, mount, toast, friendlyError, modal, field, select, empty, tabs, announce, busy, todayISO, shortDate } from '../../ui/dom.js';
import { state, can, isAdmin, branchName } from '../../state.js';
import { readExif, captureTime, cameraClocks, fileSeq, sniffType, planDay, planUnchanged, waitSentence, karachiClock, dayLabel, karachiDate, isConnectionProblem, EDIT_VERSION } from '../../lib/photo-intake.js';
import { sha256Hex, readHead, makeThumb, decode, aiCopy, renderEdit, canHeic } from '../../ui/photo-edit.js';
import { STATUS_LABELS } from './common.js';

const AI_CHUNK = 8; // photos per Claude call (supabase/functions/photo-ai/core.ts MAX_PHOTOS_PER_CALL)
const UPLOADS_AT_ONCE = 3;
const RETRY_WAITS = [2, 5, 15, 30, 60]; // seconds, after a connection problem
const REMATCH_MS = 3 * 60 * 1000;
const CITY_KEY = (id) => `photo-inbox-city:${id}`;
// The token that holds photos for editing: one per browser tab (this module is loaded once per tab), so leaving the Photo inbox and
// coming back in the same tab takes up the photos where the worker stopped, while another tab or device is another worker.
const TAB_LEASE = crypto.randomUUID();
const NO_TIME_NOTE = 'No camera time on this photo (it was sent through WhatsApp, edited in an app, or it is a screenshot). It waits on "Which patient?". Next time upload from the phone\'s gallery (Photos / Gallery app), not from WhatsApp.';
const HEIC_NOTE = 'iPhone HEIC photo: uploaded and kept, but this browser cannot show or edit it. Open the Photo inbox on an iPhone or a Mac once to edit it, or set iPhone Settings > Camera > Formats > Most Compatible.';

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A database, storage or function call tried again after a connection problem (2, 5, 15, 30, 60 s), then that error. */
async function withRetry(fn, signal, waits = RETRY_WAITS) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (!isConnectionProblem(e) || attempt >= waits.length || signal?.aborted) throw e;
      await sleep(waits[attempt] * 1000, signal);
    }
  }
}
const isCode = (e, code) => e?.photoCode === code || new RegExp(`\\b${code}\\b`).test(String(e?.message || ''));
const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
const cameraName = (key) => {
  if (!key || key === 'unknown' || key === 'mixed') return key === 'mixed' ? 'two cameras' : '';
  const model = key.split('|')[1] || key.split('|')[0];
  return model.replace(/^./, (c) => c.toUpperCase()).replace(/\biphone\b/i, 'iPhone');
};
const clockRange = (a, b) => (a ? (b && karachiClock(b) !== karachiClock(a) ? `${karachiClock(a)}-${karachiClock(b)}` : karachiClock(a)) : 'No camera time');
const dateTimeText = (iso) => `${dayLabel(karachiDate(iso))}, ${karachiClock(iso)}`;

export async function renderPhotoInbox(root, params = new URLSearchParams(), signal) {
  document.title = 'Photo inbox | Clinic system';
  const d = state.data;
  const staff = state.session.staff;
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Photo inbox')), h('p', { class: 'muted' }, 'Loading…'));
  let cities;
  try { cities = await d.photoInboxCities(); } catch (e) {
    mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Photo inbox')), h('div', { class: 'alert alert-warning', role: 'alert' }, friendlyError(e)));
    return;
  }
  if (signal?.aborted) return;
  if (!cities.length) {
    mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Photo inbox')), empty('No city folder is open to your login. The Photo inbox needs "Use the Photo inbox", "View raw clinic photos folder" and a branch in the city.'));
    return;
  }
  let remembered = null;
  try { remembered = Number(localStorage.getItem(CITY_KEY(staff.id))) || null; } catch { /* storage blocked: the first folder */ }
  const wanted = Number(params.get('city')) || remembered;
  let city = cities.find((c) => c.id === wanted) || cities[0];
  let overview = null;
  const dayCache = new Map(); // day -> photo_inbox_day answer (this city)
  const matching = new Map(); // day -> running match
  let uploading = false;
  let currentTab = ['upload', 'which', 'filed', 'aside'].includes(params.get('tab')) ? params.get('tab') : 'upload';
  let aiKey = null; // whether Claude editing is set up (null: not known yet)
  const mayDelete = can('photos.delete');

  // ---- the city folders and the branch
  const defaultHint = (c) => {
    if (c.branches.length < 2) return c.branches[0]?.id ?? null;
    if (staff.role !== 'admin' && staff.restrict_to_branches) {
      const mine = c.branches.filter((b) => (staff.branch_ids || []).map(Number).includes(b.id));
      if (mine.length === 1) return mine[0].id;
    }
    return null;
  };
  let branchHint = defaultHint(city);
  const folderBar = h('div', { class: 'inbox-folders', role: 'group', 'aria-label': 'City folder' });
  const branchRow = h('div', { class: 'inbox-branch' });
  const drawFolders = () => {
    mount(folderBar, cities.map((c) => h('button', { type: 'button', class: ['btn', 'inbox-folder', c.id === city.id ? 'btn-primary' : ''], 'aria-pressed': String(c.id === city.id),
      onclick: () => { if (c.id !== city.id) switchCity(c); } }, h('span', { 'aria-hidden': 'true', class: 'inbox-folder-icon' }, '▣'), ' ', c.name)));
    if (city.branches.length < 2) { mount(branchRow); return; }
    const sel = select([{ value: '', label: `All ${city.name} branches` }, ...city.branches.map((b) => ({ value: b.id, label: b.name }))], branchHint ?? '',
      { onchange: (e) => { branchHint = e.target.value ? Number(e.target.value) : null; } });
    mount(branchRow, field('Which branch were these taken at?', sel, 'Photos of one branch can only be matched to that branch\'s patients. "All branches" when the photos come from more than one.'));
  };
  const switchCity = (c) => {
    if (uploading) { toast('Photos are still uploading into this folder. Wait for them to finish.'); return; }
    city = c;
    branchHint = defaultHint(c);
    dayCache.clear();
    try { localStorage.setItem(CITY_KEY(staff.id), String(c.id)); } catch { /* storage blocked */ }
    drawFolders();
    refreshCounts();
    showTab(currentTab);
  };

  // ---- the tabs
  const tabLabel = (n) => (n ? `Which patient? (${n})` : 'Which patient?');
  const strip = tabs({ label: 'Photo inbox', current: currentTab, items: [
    { id: 'upload', label: 'Upload' }, { id: 'which', label: tabLabel(0) }, { id: 'filed', label: 'Filed' }, { id: 'aside', label: 'Set aside' },
  ], onChange: (id) => showTab(id) });
  strip.el.classList.add('inbox-tabs');
  const panel = strip.panel;
  const aiBanner = h('div', { class: 'inbox-banner', role: 'status', 'aria-live': 'polite' });
  const costLine = h('div', { class: 'inbox-costs' });
  const setTabCount = (n) => { const b = strip.el.querySelectorAll('[role="tab"]')[1]; if (b) b.textContent = tabLabel(n); };
  async function refreshCounts() {
    try {
      const c = await d.photoInboxCounts();
      setTabCount(c.waiting + c.check);
      window.dispatchEvent(new CustomEvent('photo-inbox-count', { detail: c.waiting + c.check }));
    } catch { /* the count is a convenience */ }
  }

  // "Photo requests" (owner, 17 Oct 2026): patients who pressed "Please upload my photos" in their account. Oldest first, with Open patient
  // and Done; a request closes by itself when photos are saved for that patient (a profile upload or a filing here). The count is in the heading.
  const requestsPanel = h('details', { class: 'panel photo-requests', open: true });
  async function drawRequests() {
    let rows = [];
    try { rows = typeof d.photoRequestsOpen === 'function' ? await d.photoRequestsOpen() : []; } catch { rows = []; }
    mount(requestsPanel,
      h('summary', {}, h('h2', { style: { display: 'inline' } }, `Photo requests${rows.length ? ` (${rows.length})` : ''}`)),
      rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'list photo-requests-list' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Patient'), h('th', { scope: 'col' }, 'Branch'), h('th', { scope: 'col' }, 'Last visit'), h('th', { scope: 'col' }, 'Asked on'), h('th', { scope: 'col' }, srOnlyText('Actions')))),
        h('tbody', {}, rows.map((r) => h('tr', {},
          h('td', {}, h('strong', {}, r.full_name), ' ', h('span', { class: 'mr' }, `Mr# ${r.mr_number}`)),
          h('td', {}, r.first_branch_id ? branchName(r.first_branch_id) : ''),
          h('td', { class: 'nowrap' }, r.last_visit ? shortDate(r.last_visit) : 'No visit yet'),
          h('td', { class: 'nowrap' }, shortDate(String(r.requested_at).slice(0, 10))),
          h('td', { class: 'right nowrap' }, h('span', { class: 'inline', style: { justifyContent: 'flex-end' } },
            h('a', { class: 'btn btn-small', href: `#/staff/patient/${r.patient_id}` }, 'Open patient'),
            h('button', { type: 'button', class: 'btn btn-small', onclick: busy(async () => { await d.photoRequestDone(r.id); toast('Marked done.', 'ok'); await drawRequests(); }) }, 'Done'))))))))
        : h('p', { class: 'muted', style: { margin: '8px 0 0' } }, 'No patient is asking for photos right now. A patient asks with "Please upload my photos" in their account.'));
  }
  const srOnlyText = (t) => h('span', { class: 'sr-only' }, t);

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Photo inbox'),
      h('p', { class: 'muted' }, 'Take the photos all day; after the last patient, choose them all here in one go, into the city folder. Each patient is found by the time the photo was taken; when it is not clear you are asked "Which patient?". Claude edits them, and every photo gets a proper name.'))),
    requestsPanel,
    h('div', { class: 'photo-inbox' }, folderBar, branchRow, aiBanner, strip.el, panel, costLine));
  drawFolders();
  drawRequests();

  async function loadOverview() {
    overview = await d.photoInboxOverview(city.id);
    return overview;
  }
  /** Matches one day of this city (the whole day at once) and applies the plan unless nothing would change. Answers { data, res }. */
  function matchDay(day) {
    const key = `${city.id}|${day}`;
    if (matching.has(key)) return matching.get(key);
    const cityId = city.id;
    const run = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const data = await d.photoInboxDay(cityId, day);
        const plan = planDay(data);
        if (planUnchanged(plan, data)) { if (cityId === city.id) dayCache.set(day, data); return { data, res: null }; }
        try {
          const res = await d.photoInboxApply(cityId, day, plan);
          const fresh = await d.photoInboxDay(cityId, day);
          if (cityId === city.id) dayCache.set(day, fresh);
          return { data: fresh, res };
        } catch (e) {
          if (!isCode(e, 'PHOTO_STALE_PLAN')) throw e;
        }
      }
      const data = await d.photoInboxDay(cityId, day);
      if (cityId === city.id) dayCache.set(day, data);
      return { data, res: null };
    })().finally(() => matching.delete(key));
    matching.set(key, run);
    return run;
  }
  async function dayData(day, { fresh = false } = {}) {
    if (!fresh && dayCache.has(day)) return dayCache.get(day);
    const data = await d.photoInboxDay(city.id, day);
    dayCache.set(day, data);
    return data;
  }
  /** Signed links for the small copies (edited first, else the original's), in one call. */
  async function thumbLinks(items) {
    const paths = items.flatMap((i) => [i.edited_thumb_path, i.thumb_path, i.thumb_path || i.edited_thumb_path ? null : i.storage_path]).filter(Boolean);
    try { return await d.signedUrls(paths, { width: 320 }); } catch { return new Map(); }
  }
  const thumbSrc = (links, i) => links.get(i.edited_thumb_path) || links.get(i.thumb_path) || links.get(i.storage_path) || null;
  function openPhoto(i, title) {
    const body = h('div', { class: 'inbox-lightbox' }, h('p', { class: 'muted' }, 'Loading the photo…'));
    modal(title, body, [{ label: 'Close', primary: true }]);
    const path = i.edited_path || i.storage_path;
    d.signedUrls([path]).then((links) => {
      const src = links.get(path);
      const heic = /hei[cf]/i.test(i.mime_type || '') && !i.edited_path && !canHeic();
      mount(body, heic ? h('p', {}, HEIC_NOTE) : src ? h('img', { src, alt: title }) : h('p', {}, 'This photo cannot be shown just now.'),
        h('p', { class: 'muted' }, [i.file_name, i.taken_at ? dateTimeText(i.taken_at) : 'No camera time', i.edited_path ? 'edited copy' : 'original'].filter(Boolean).join(' · ')));
    }).catch((e) => mount(body, h('p', {}, friendlyError(e))));
  }
  const strip_ = (items, links, set, { split = null } = {}) => h('div', { class: 'inbox-strip' }, items.map((i, n) => h('div', { class: 'inbox-thumb' },
    h('button', { type: 'button', class: 'inbox-thumb-btn', 'aria-label': `Open photo ${n + 1} of ${items.length}${i.taken_at ? `, taken ${dateTimeText(i.taken_at)}` : ''}`,
      onclick: () => openPhoto(i, `Photo ${n + 1} of ${items.length}`) },
    thumbSrc(links, i) ? h('img', { src: thumbSrc(links, i), alt: '', loading: 'lazy' }) : h('span', { class: 'inbox-noprev' }, /hei[cf]/i.test(i.mime_type || '') ? 'HEIC photo: no preview in this browser' : 'No preview')),
    split && n > 0 ? h('button', { type: 'button', class: 'btn btn-small inbox-split-here', 'aria-label': `Next patient starts at photo ${n + 1}`, onclick: () => split(i) }, 'Next patient starts here') : null)));

  // ---------------------------------------------------------------- Upload
  async function renderUpload() {
    const input = h('input', { type: 'file', multiple: true, accept: 'image/*', class: 'sr-only', 'aria-label': 'Choose photos', tabindex: '-1',
      onchange: () => { const list = [...input.files]; input.value = ''; if (list.length) uploadBatch(list); } });
    const choose = h('button', { type: 'button', class: 'btn btn-primary inbox-choose', onclick: () => input.click() }, 'Choose photos');
    const drop = h('div', { class: 'inbox-drop' },
      h('p', {}, h('strong', {}, `Folder: ${city.name}`)),
      h('p', {}, 'Choose all of the day\'s photos at once, from the phone\'s gallery (Photos / Gallery app), not from WhatsApp. On a laptop you can also drop them here.'),
      choose, input);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const list = [...(e.dataTransfer?.files || [])]; if (list.length) uploadBatch(list); });
    mount(panel, drop, uploadArea);
  }
  const uploadArea = h('div', { class: 'inbox-upload' });

  async function uploadBatch(files) {
    if (uploading) { toast('Photos are still uploading. Wait for them to finish.'); return; }
    uploading = true;
    const cityNow = city;
    const hint = branchHint;
    const batch = crypto.randomUUID();
    const pickedAt = Date.now();
    const summary = h('p', { class: 'inbox-summary', 'aria-live': 'polite' }, `Reading ${plural(files.length, 'photo')}…`);
    const bar = h('progress', { max: String(files.length), value: '0', 'aria-label': 'Upload progress' });
    const status = h('p', { class: 'inbox-progress', role: 'status' });
    const list = h('ul', { class: 'inbox-files' });
    const result = h('div', { class: 'inbox-result' });
    mount(uploadArea, summary, bar, status, result, list);
    let wake = null;
    try { wake = await navigator.wakeLock?.request?.('screen'); } catch { /* not offered: the screen may sleep */ }
    const leaveWarning = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', leaveWarning);
    const rows = files.map((file) => ({ file, li: h('li', {}, h('span', { class: 'inbox-file-name' }, file.name), ' ', h('span', { class: 'inbox-file-state' }, 'Waiting')), state: 'waiting' }));
    list.append(...rows.map((r) => r.li));
    const setRow = (r, stateName, note = '') => {
      r.state = stateName;
      r.li.querySelector('.inbox-file-state').textContent = note || stateName;
      r.li.className = `inbox-file inbox-file-${stateName}`;
    };
    try {
      // 1. read: type, camera time, fingerprint, small copy (one photo at a time)
      const seen = new Map();
      for (const r of rows) {
        if (signal?.aborted) return;
        const head = await readHead(r.file);
        const sn = sniffType(head.subarray(0, 12), r.file.name, r.file.size, r.file.type);
        if (!sn.ok) { setRow(r, 'rejected', sn.reason); continue; }
        const exif = readExif(head);
        const t = captureTime({ exif, lastModified: r.file.lastModified, pickedAt, uploadedAt: Date.now() });
        const sha = await sha256Hex(r.file);
        if (seen.has(sha)) { setRow(r, 'already', 'The same photo was chosen twice'); continue; }
        seen.set(sha, r);
        const th = await makeThumb(r.file);
        const seq = fileSeq(r.file.name);
        r.meta = { sha, ext: sn.ext, mime: sn.mime, t, thumb: th.blob, width: th.width, height: th.height, seq };
        let note = 'Ready';
        if (!th.blob && /hei[cf]/.test(sn.ext)) note = HEIC_NOTE;
        if (!t.time_ok) note = t.time_source === 'exif' && !t.clock_ok ? `The camera's date is wrong (it says ${t.taken_at ? dateTimeText(t.taken_at) : 'no date'}). Set the phone to automatic date and time. It waits on "Which patient?".` : NO_TIME_NOTE;
        setRow(r, 'ready', note);
      }
      const ready = rows.filter((r) => r.state === 'ready');
      // Each camera's clock judged over all its photos of this upload: a clock that runs ahead, or a phone on the wrong time zone, makes
      // every photo of that camera wait on "Which patient?" (they would be matched at the wrong time). Each camera's newest photo time
      // is shown, so staff see a wrong clock themselves.
      const uploadedAt = Date.now();
      const clocks = cameraClocks(ready.map((r) => ({ t: r.meta.t, lastModified: r.file.lastModified, pickedAt })), uploadedAt);
      const suspect = new Map(clocks.filter((c) => c.suspect).map((c) => [c.camera, c]));
      for (const r of ready) {
        const c = suspect.get(r.meta.t.camera);
        if (!c || r.meta.t.time_source !== 'exif') continue;
        r.meta.t = { ...r.meta.t, clock_ok: false, time_ok: false };
        setRow(r, 'ready', c.why === 'ahead'
          ? `This phone's clock runs ahead (its last photo says ${dateTimeText(new Date(c.newest).toISOString())}, later than now). Its photos wait on "Which patient?". Set the phone to automatic date and time.`
          : `This phone's time zone looks wrong (its camera times are whole hours away from the files' own times). Its photos wait on "Which patient?". Set the phone to automatic date, time and time zone.`);
      }
      const cameraLine = clocks.length ? ` · ${clocks.map((c) => `${cameraName(c.camera) || 'Camera'}: ${plural(c.count, 'photo')}, the last at ${karachiClock(c.newest)}${c.suspect ? ' (its clock looks wrong)' : ''}`).join('; ')} (now ${karachiClock(uploadedAt)})` : '';
      const withTime = ready.filter((r) => r.meta.t.time_ok).length;
      const days = new Map();
      for (const r of ready) days.set(r.meta.t.photo_day, (days.get(r.meta.t.photo_day) || 0) + 1);
      summary.textContent = `${plural(ready.length, 'photo')} · ${withTime} with camera time${ready.length - withTime ? ` · ${ready.length - withTime} without (sent through WhatsApp or screenshots: upload from the phone's gallery next time)` : ''}`
        + (days.size ? ` · days: ${[...days].sort().map(([day, n]) => `${dayLabel(day)} (${n})`).join(', ')}` : '') + cameraLine;
      // 2. already uploaded?
      const known = ready.length ? await withRetry(() => d.photoInboxKnown(ready.map((r) => r.meta.sha)), signal) : [];
      const knownBy = new Map(known.map((k) => [k.sha256, k]));
      for (const r of ready) {
        const k = knownBy.get(r.meta.sha);
        if (k) setRow(r, 'already', `Already uploaded (${k.city_name}, ${dayLabel(k.photo_day)})`);
      }
      const todo = ready.filter((r) => r.state === 'ready');
      const totalBytes = todo.reduce((s, r) => s + r.file.size, 0);
      let doneCount = 0;
      let doneBytes = 0;
      let stopped = null;
      const showProgress = () => {
        bar.value = String(doneCount + rows.length - todo.length);
        status.textContent = `Uploading ${Math.min(doneCount + 1, todo.length)} of ${todo.length} (${mb(doneBytes)} of ${mb(totalBytes)})`;
        if (doneCount % 5 === 0 || doneCount === todo.length) announce(status.textContent);
      };
      // 3. upload, three at a time, with retries; 4. register in groups of up to 20 (tried again after a connection problem; a group
      // that still does not get through goes back on the list, and every worker stops: the photos are stored, choosing them again
      // finishes the job)
      const toRegister = [];
      const added = [];
      let regError = null;
      const register = async (force = false) => {
        while (toRegister.length && (force || toRegister.length >= 20)) {
          const part = toRegister.splice(0, 20);
          let res;
          try {
            res = await withRetry(() => d.photoInboxAddItems(part.map((r) => ({
            city_id: cityNow.id, sha256: r.meta.sha, ext: r.meta.ext, photo_day: r.meta.t.photo_day, file_name: r.file.name.slice(0, 200), mime_type: r.meta.mime,
            byte_size: r.file.size, width: r.meta.width, height: r.meta.height, taken_at: r.meta.t.taken_at, time_source: r.meta.t.time_source, clock_ok: r.meta.t.clock_ok,
            camera: r.meta.t.camera, orientation: r.meta.t.orientation, file_seq_prefix: r.meta.seq?.prefix ?? null, file_seq: r.meta.seq?.seq ?? null,
            branch_hint: hint, upload_batch: batch, thumb: !!r.thumbPath,
            }))), signal);
          } catch (e) { toRegister.unshift(...part); throw e; }
          for (const x of res) {
            const r = part.find((p) => p.meta.sha === x.sha256);
            if (!r) continue;
            if (x.state === 'added') { added.push(r); setRow(r, 'uploaded', r.meta.t.time_ok ? 'Uploaded' : 'Uploaded (no camera time: it waits on "Which patient?")'); }
            else setRow(r, 'already', `Already uploaded (${cities.find((c) => c.id === x.city_id)?.name || ''}, ${dayLabel(x.photo_day)})`);
          }
        }
      };
      const queue = [...todo];
      const worker = async () => {
        while (queue.length && !stopped && !signal?.aborted) {
          const r = queue.shift();
          setRow(r, 'uploading', 'Uploading');
          for (let attempt = 0; ; attempt++) {
            try {
              const up = await d.photoInboxUpload({ citySlug: cityNow.slug, day: r.meta.t.photo_day, sha: r.meta.sha, ext: r.meta.ext, file: r.file, thumb: r.meta.thumb, mime: r.meta.mime });
              r.thumbPath = up.thumbPath;
              setRow(r, 'stored', 'Stored');
              toRegister.push(r);
              break;
            } catch (e) {
              if (e.code === 'STORAGE_FULL') { stopped = e; setRow(r, 'failed', 'Not uploaded: storage full'); return; }
              if (e.code === 'NETWORK' && attempt < RETRY_WAITS.length) {
                setRow(r, 'uploading', `Connection problem: trying again in ${RETRY_WAITS[attempt]} s`);
                await sleep(RETRY_WAITS[attempt] * 1000, signal);
                continue;
              }
              setRow(r, 'failed', e.code === 'NETWORK' ? 'Waiting to retry: choose the same photos again (nothing is uploaded twice)' : friendlyError(e));
              break;
            }
          }
          doneCount++;
          doneBytes += r.file.size;
          showProgress();
          try { await register(false); } catch (e) { regError = regError || e; stopped = stopped || e; return; }
        }
      };
      if (todo.length) { showProgress(); await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, todo.length) }, worker)); }
      if (!regError) { try { await register(true); } catch (e) { regError = e; } }
      for (const r of toRegister) setRow(r, 'failed', 'Stored, but not yet in the list (connection): choose the same photos again to finish (nothing is uploaded twice)');
      // (photos the stopped workers did not reach)
      for (const r of queue) setRow(r, 'failed', stopped?.code === 'STORAGE_FULL' ? 'Not uploaded: storage full' : 'Not uploaded yet: choose the same photos again to finish (nothing is uploaded twice)');
      bar.value = String(rows.length);
      status.textContent = '';
      // 5. match every day touched, the whole day at once (what did register is matched even when the rest did not)
      let filed = 0;
      const touched = [...new Set(added.map((r) => r.meta.t.photo_day))].sort();
      const waitingSets = new Set();
      const unmatched = [];
      for (const day of touched) {
        try {
          const { data, res } = await withRetry(() => matchDay(day), signal);
          filed += Number(res?.filed || 0);
          for (const s of data.sets) if (s.status === 'waiting') waitingSets.add(s.set_id);
        } catch { unmatched.push(day); }
      }
      const already = rows.filter((r) => r.state === 'already').length;
      const noTime = added.filter((r) => !r.meta.t.time_ok).length;
      const failed = rows.filter((r) => r.state === 'failed').length;
      const lines = [];
      if (added.length) lines.push(`${plural(added.length, 'photo')} uploaded${already ? ` (${already} ${already === 1 ? 'was' : 'were'} already there)` : ''}.`);
      else if (already) lines.push(`Nothing new: ${already} ${already === 1 ? 'photo was' : 'photos were'} already uploaded.`);
      if (touched.length) lines.push(`${plural(filed, 'set')} filed automatically. ${plural(waitingSets.size, 'set')} ${waitingSets.size === 1 ? 'waits' : 'wait'} on "Which patient?".`);
      if (noTime) lines.push(`${plural(noTime, 'photo')} ${noTime === 1 ? 'has' : 'have'} no camera time.`);
      if (failed && (!stopped || regError)) lines.push(`${plural(failed, 'photo')} did not finish: choose the same photos again to finish (nothing is uploaded twice).`);
      if (unmatched.length) lines.push(`Matching did not finish for ${unmatched.map(dayLabel).join(', ')} (connection): it runs again by itself within 3 minutes while this page is open, or press "Check again".`);
      const rejected = rows.filter((r) => r.state === 'rejected').length;
      if (rejected) lines.push(`${plural(rejected, 'file')} ${rejected === 1 ? 'is' : 'are'} not a photo the inbox takes (see the list).`);
      mount(result,
        stopped ? h('div', { class: 'alert alert-warning', role: 'alert' }, friendlyError(stopped)) : null,
        h('div', { class: 'alert alert-info inbox-done', role: 'status' }, lines.join(' '),
          waitingSets.size ? [' ', h('button', { type: 'button', class: 'btn btn-small', onclick: () => { strip.setCurrent('which'); showTab('which'); } }, 'Go to Which patient?')] : null));
      announce(lines.join(' '));
      refreshCounts();
      loadOverview().catch(() => {});
    } catch (e) {
      mount(result, h('div', { class: 'alert alert-warning', role: 'alert' }, friendlyError(e)));
    } finally {
      uploading = false;
      window.removeEventListener('beforeunload', leaveWarning);
      try { await wake?.release?.(); } catch { /* already released */ }
      if (workerRunning) poke?.(); else startWorker();
    }
  }

  // ---------------------------------------------------------------- Which patient?
  const visitLine = (data, v) => {
    const b = data.branches.find((x) => x.id === v.branch_id)?.code || '';
    const occasion = v.photo_required ? `${v.braces_month ? `Month ${v.braces_month}` : v.treatment_label || 'Photo month'} (photo month)` : (v.braces_month ? `Month ${v.braces_month}` : v.treatment_label || '');
    const time = v.started_at ? `in chair ${karachiClock(v.started_at)}` : v.checked_in_at ? `checked in ${karachiClock(v.checked_in_at)}` : v.completed_at ? `completed ${karachiClock(v.completed_at)}` : 'no times on the list';
    return [`${v.full_name}`, `Mr# ${v.mr_number}`, b, occasion, time, v.status !== 'completed' && v.status !== 'in_treatment' ? STATUS_LABELS[v.status] : null].filter(Boolean).join(' · ');
  };
  const reloadAfter = async (e) => {
    toast(friendlyError(e), 'error');
    if (isCode(e, 'PHOTO_STALE') || isCode(e, 'PHOTO_SET_STATE')) { dayCache.clear(); showTab(currentTab); }
  };
  /** The day's list to search (and "Search all patients"). listAll: show the list before anything is typed (else only matches). */
  function chooser(data, { onVisit, onPatient, label, listAll = true }) {
    const box = h('div', { class: 'inbox-chooser' });
    const q = h('input', { type: 'search', placeholder: 'Name, Mr# or token', 'aria-label': `Search the ${data.city.name} list of ${dayLabel(data.day)}` });
    const results = h('div', { class: 'inbox-chooser-results' });
    const all = h('div', { class: 'inbox-chooser-all' });
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      if (!t && !listAll) { mount(results, h('p', { class: 'muted' }, 'Type the patient’s name, Mr# or token.')); return; }
      const hits = data.visits.filter((v) => !t || v.full_name.toLowerCase().includes(t) || String(v.mr_number).toLowerCase().startsWith(t) || String(v.token_no ?? '') === t).slice(0, 12);
      mount(results, hits.length ? hits.map((v) => h('button', { type: 'button', class: 'btn inbox-candidate', 'aria-label': `${label}: ${visitLine(data, v)}`, onclick: () => onVisit(v) }, visitLine(data, v)))
        : h('p', { class: 'muted' }, `Nobody on the ${data.city.name} list of ${dayLabel(data.day)} matches.`));
    };
    q.addEventListener('input', draw);
    const searchAll = h('button', { type: 'button', class: 'btn btn-small', onclick: busy(async () => {
      const t = q.value.trim();
      if (!t) { toast('Type a name or Mr# first.'); return; }
      const found = (await d.searchPatients(t)).slice(0, 10);
      mount(all, found.length ? found.map((p) => h('button', { type: 'button', class: 'btn inbox-candidate', 'aria-label': `${label}: ${p.full_name}, Mr# ${p.mr_number}`, onclick: () => onPatient(p) },
        `${p.full_name} · Mr# ${p.mr_number}`)) : h('p', { class: 'muted' }, 'No patient matches.'));
    }) }, 'Search all patients');
    draw();
    mount(box, q, results, h('div', { class: 'inline' }, searchAll, h('span', { class: 'muted' }, 'for a patient who is not on this day\'s list')), all);
    return box;
  }
  function waitCard(data, s, links, { flagged = false } = {}) {
    const items = data.items.filter((i) => i.set_id === s.set_id).sort((a, b) => a.position - b.position);
    const range = clockRange(s.first_at, s.last_at);
    const wrongClock = items.find((i) => i.time_source === 'exif' && !i.clock_ok && i.taken_at);
    const orphan = flagged && !s.patient_id; // filed to a patient record that was removed
    const reason = orphan ? 'The patient record these photos were filed to is not there any more (removed). Move them to the right patient.'
      : flagged ? (s.ai_flag === 'mixed_people' ? 'Claude thinks these photos show more than one patient. They are held back from the patient until you check them.' : 'Claude thinks a photo here is not a patient photo (floor, ceiling, an accidental shot). Take it out, or press "It\'s fine".')
        : waitSentence(s.wait_reason, { city: data.city.name, day: dayLabel(data.day), date: wrongClock ? dateTimeText(wrongClock.taken_at) : '' });
    const card = h('article', { class: ['inbox-card', flagged ? 'inbox-card-flagged' : ''], 'aria-label': `Photos of ${dayLabel(data.day)}, ${range}` });
    let splitMode = false;
    const draw = () => {
      const cands = (s.candidates || []).slice(0, 3).map((c) => ({ c, v: data.visits.find((x) => x.visit_id === c.visit_id) })).filter((x) => x.v);
      const fileTo = async (opts, who) => {
        try {
          await d.photoInboxFileSet(s.set_id, { ...opts, version: s.version });
          const msg = h('span', {}, `Filed in ${who.full_name}'s file (Mr# ${who.mr_number}).`);
          toast(msg, 'ok', 6000);
          dayCache.delete(data.day);
          refreshCounts();
          showTab('which');
        } catch (e) { reloadAfter(e); }
      };
      // No likely patients (no usable camera time): the search is open at once.
      const someone = h('div', { class: 'inbox-someone', hidden: cands.length > 0 });
      mount(card,
        h('div', { class: 'inbox-card-head' },
          h('strong', {}, `${dayLabel(data.day)} · ${range} · ${plural(s.photo_count, 'photo')}${cameraName(s.camera) ? ` · ${cameraName(s.camera)}` : ''}`),
          flagged && s.full_name ? h('span', {}, ` · filed in ${s.full_name}'s file (Mr# ${s.mr_number})`) : null),
        h('p', { class: 'inbox-reason' }, reason),
        strip_(items, links, s, { split: splitMode ? async (i) => {
          try { await d.photoInboxSplitSet(s.set_id, i.item_id, s.version); toast('Split into two sets: choose the patient for each.', 'ok'); dayCache.delete(data.day); showTab('which'); } catch (e) { reloadAfter(e); }
        } : null }),
        flagged ? h('div', { class: 'inline inbox-actions' },
          orphan ? null : h('button', { type: 'button', class: 'btn btn-primary', onclick: busy(async () => { try { await d.photoInboxResolveFlag(s.set_id); toast('Marked as fine.', 'ok'); dayCache.delete(data.day); refreshCounts(); showTab('which'); } catch (e) { reloadAfter(e); } }) }, 'It\'s fine'),
          mayDelete ? h('button', { type: 'button', class: 'btn', onclick: () => moveModal(data, s) }, 'Move to another patient…') : null,
          mayDelete ? h('button', { type: 'button', class: 'btn', onclick: () => undoModal(data, s) }, 'Undo filing') : null)
          : [
            cands.length ? h('div', { class: 'inbox-candidates', role: 'group', 'aria-label': 'Likely patients' }, cands.map(({ c, v }) => h('button', {
              type: 'button', class: ['btn', 'inbox-candidate', c.proposal ? 'inbox-candidate-first' : ''],
              'aria-label': `File the photos of ${range} in ${v.full_name}'s file, Mr# ${v.mr_number}`,
              onclick: busy(() => fileTo({ visitId: v.visit_id }, v)),
            }, visitLine(data, v), (c.reasons || []).includes('HAS_PHOTOS') ? h('span', { class: 'badge badge-warn' }, 'already has photos') : null))) : null,
            h('div', { class: 'inline inbox-actions' },
              h('button', { type: 'button', class: 'btn', 'aria-expanded': String(!cands.length), onclick: (e) => { someone.hidden = !someone.hidden; e.currentTarget.setAttribute('aria-expanded', String(!someone.hidden)); if (!someone.hidden) someone.querySelector('input')?.focus(); } }, 'Someone else…'),
              h('button', { type: 'button', class: 'btn', onclick: busy(async () => { try { await d.photoInboxSetAside(s.set_id, s.version); toast('Set aside (the photos are kept).', 'ok'); dayCache.delete(data.day); refreshCounts(); showTab('which'); } catch (e) { reloadAfter(e); } }) }, 'Not a patient photo'),
              items.length > 1 ? h('button', { type: 'button', class: 'btn', 'aria-pressed': String(splitMode), onclick: () => { splitMode = !splitMode; draw(); } }, splitMode ? 'Stop splitting' : 'Split this set') : null,
              cities.length > 1 ? (() => {
                const sel = select([{ value: '', label: 'Move to another city folder…' }, ...cities.filter((c) => c.id !== city.id).map((c) => ({ value: c.id, label: c.name }))], '', {
                  'aria-label': 'Move these photos to another city folder',
                  onchange: async (e) => { const to = Number(e.target.value); if (!to) return; try { await d.photoInboxMoveCity(s.set_id, to, s.version); toast(`Moved to the ${cities.find((c) => c.id === to)?.name} folder.`, 'ok'); dayCache.delete(data.day); refreshCounts(); showTab('which'); } catch (err) { reloadAfter(err); } },
                });
                return sel;
              })() : null),
            someone,
          ]);
      if (!flagged) mount(someone, chooser(data, { label: 'File the photos in this patient\'s file', listAll: cands.length > 0, onVisit: (v) => fileTo({ visitId: v.visit_id }, v), onPatient: (p) => fileTo({ patientId: p.id }, p) }));
    };
    draw();
    return card;
  }
  async function renderWhich() {
    mount(panel, h('p', { class: 'muted' }, 'Matching…'));
    await loadOverview();
    const days = [...new Set([...(overview.waiting_days || []), ...(overview.check_days || [])])].sort();
    const loaded = [];
    for (const day of days) {
      try { loaded.push((await matchDay(day)).data); } catch (e) { toast(friendlyError(e), 'error'); }
    }
    const toCheck = (s) => s.status === 'filed' && (s.ai_flag || !s.patient_id);
    const allItems = loaded.flatMap((x) => x.items.filter((i) => x.sets.some((s) => s.set_id === i.set_id && (s.status === 'waiting' || toCheck(s)))));
    const links = await thumbLinks(allItems);
    const check = loaded.flatMap((data) => data.sets.filter(toCheck).map((s) => waitCard(data, s, links, { flagged: true })));
    const cards = loaded.flatMap((data) => data.sets.filter((s) => s.status === 'waiting').map((s) => waitCard(data, s, links)));
    const again = h('button', { type: 'button', class: 'btn btn-small', onclick: busy(async () => { dayCache.clear(); await renderWhich(); toast('Checked again.', 'ok'); }) }, 'Check again');
    mount(panel,
      h('div', { class: 'inline inbox-panel-head' }, h('h2', {}, 'Which patient?'), again,
        h('span', { class: 'muted' }, 'Photos the system could not match for sure. One tap on the right patient files them.')),
      check.length ? [h('h3', {}, 'Check these'), ...check] : null,
      cards.length ? cards : empty(check.length ? 'Nothing else waits.' : 'Nothing waits. Every set is filed or set aside.'));
    refreshCounts();
  }

  // ---------------------------------------------------------------- Filed
  function moveModal(data, s) {
    const body = h('div', {}, h('p', {}, `Moves these ${plural(s.photo_count, 'photo')} to another patient's file. The patient sees them 24 hours after the move.`),
      chooser(data, {
        label: 'Move the photos to this patient',
        onVisit: async (v) => { try { await d.photoInboxMoveSet(s.set_id, { visitId: v.visit_id }); toast(`Moved to ${v.full_name}'s file (Mr# ${v.mr_number}).`, 'ok'); dlg.close(); dayCache.delete(data.day); showTab(currentTab); } catch (e) { reloadAfter(e); } },
        onPatient: async (p) => { try { await d.photoInboxMoveSet(s.set_id, { patientId: p.id }); toast(`Moved to ${p.full_name}'s file (Mr# ${p.mr_number}).`, 'ok'); dlg.close(); dayCache.delete(data.day); showTab(currentTab); } catch (e) { reloadAfter(e); } },
      }));
    const dlg = modal('Move to another patient', body, [{ label: 'Cancel', dismiss: true }]);
  }
  function undoModal(data, s) {
    modal('Undo filing?', h('p', {}, `Takes these ${plural(s.photo_count, 'photo')} out of ${s.full_name || 'the patient'}'s file and puts them back on "Which patient?". The photos are kept.`), [
      { label: 'Cancel' },
      { label: 'Undo filing', danger: true, onClick: async () => {
        try { await d.photoInboxUnfileSet(s.set_id); toast('The filing was undone: the photos wait on "Which patient?".', 'ok'); dayCache.delete(data.day); refreshCounts(); showTab(currentTab); } catch (e) { reloadAfter(e); return false; }
      } },
    ], { destructive: true });
  }
  function filedCard(data, s, links) {
    const items = data.items.filter((i) => i.set_id === s.set_id).sort((a, b) => a.position - b.position);
    const edited = items.filter((i) => i.edit_status === 'done').length;
    const basic = items.filter((i) => i.edit_status === 'done' && i.edit_basic).length;
    const heic = items.filter((i) => i.edit_status === 'needs_safari').length;
    const failed = items.filter((i) => i.edit_status === 'failed').length;
    const editing = edited === items.length ? (basic ? `Edited. Claude could not edit ${plural(basic, 'photo')}: basic edit made.` : 'Edited.')
      : heic ? `${plural(heic, 'iPhone HEIC photo')}: edit from Safari (iPhone or Mac).` : aiKey === false ? 'Editing waits for the AI key.' : `Editing: ${edited} of ${items.length} done.`;
    // "Try Claude again": basic edits (Claude refused, or could not be reached for these photos) and photos whose editing failed.
    const redo = (basic || failed || heic) && aiKey ? h('button', { type: 'button', class: 'btn', onclick: busy(async () => {
      try {
        const r = await d.photoInboxRedoEdits(s.set_id);
        toast(`${plural(Number(r?.photos || 0), 'photo')} will be edited again by Claude.`, 'ok');
        dayCache.delete(data.day);
        if (workerRunning) poke?.(); else startWorker();
        showTab('filed');
      } catch (e) { reloadAfter(e); }
    }) }, 'Try Claude again') : null;
    const release = s.release_after ? Date.parse(s.release_after) : 0;
    const seen = s.hidden ? 'Hidden from the patient.' : s.ai_flag === 'mixed_people' ? 'Held back from the patient: Claude thinks these show more than one patient.'
      : release > Date.now() ? `The patient sees these from ${dateTimeText(s.release_after)}.` : 'Visible to the patient.';
    const how = s.filed_how === 'auto' ? s.filed_rule || 'Automatic' : `Confirmed by ${s.filed_by_name || 'staff'}`;
    return h('article', { class: 'inbox-card inbox-filed', 'aria-label': `Filed: ${s.full_name || 'patient'}, ${clockRange(s.first_at, s.last_at)}` },
      h('div', { class: 'inbox-card-head' },
        s.patient_id ? h('a', { href: `#/staff/patient/${s.patient_id}` }, `${s.full_name} · Mr# ${s.mr_number}`) : h('strong', {}, 'Patient'),
        h('span', {}, [s.branch_id ? data.branches.find((b) => b.id === s.branch_id)?.code : null, s.occasion, clockRange(s.first_at, s.last_at), plural(s.photo_count, 'photo')].filter(Boolean).map((x) => ` · ${x}`).join(''))),
      h('p', { class: 'muted' }, how),
      strip_(items, links, s),
      h('p', {}, editing, ' ', seen),
      h('div', { class: 'inline inbox-actions' },
        h('button', { type: 'button', class: 'btn', onclick: busy(async () => {
          try { await d.photoInboxHideSet(s.set_id, !s.hidden); toast(s.hidden ? 'The patient will see these again.' : 'Hidden from the patient.', 'ok'); dayCache.delete(data.day); showTab('filed'); } catch (e) { reloadAfter(e); }
        }) }, s.hidden ? 'Show to patient' : 'Hide from patient'),
        redo,
        mayDelete ? h('button', { type: 'button', class: 'btn', onclick: () => moveModal(data, s) }, 'Move to another patient…') : null,
        mayDelete ? h('button', { type: 'button', class: 'btn', onclick: () => undoModal(data, s) }, 'Undo filing') : null),
      mayDelete && items.length > 1 ? h('details', { class: 'inbox-takeout' }, h('summary', {}, 'Take one photo out'),
        h('div', { class: 'inline' }, items.map((i, n) => h('button', { type: 'button', class: 'btn btn-small', onclick: busy(async () => {
          try { await d.photoInboxTakeOut(i.item_id); toast(`Photo ${n + 1} was taken out and set aside (kept).`, 'ok'); dayCache.delete(data.day); showTab('filed'); } catch (e) { reloadAfter(e); }
        }) }, `Take out photo ${n + 1}`)))) : null);
  }
  let filedDay = null;
  async function renderFiled() {
    mount(panel, h('p', { class: 'muted' }, 'Loading…'));
    await loadOverview();
    const days = (overview.days || []).filter((x) => x.filed > 0).map((x) => x.day);
    if (!days.length) { mount(panel, empty('Nothing is filed in this folder yet.')); return; }
    if (!filedDay || !days.includes(filedDay)) filedDay = days[0];
    const data = await dayData(filedDay, { fresh: true });
    const sets = data.sets.filter((s) => s.status === 'filed');
    const links = await thumbLinks(data.items.filter((i) => sets.some((s) => s.set_id === i.set_id)));
    const daySel = select(days.map((day) => ({ value: day, label: dayLabel(day) })), filedDay, { onchange: (e) => { filedDay = e.target.value; renderFiled(); } });
    mount(panel, h('div', { class: 'inline inbox-panel-head' }, h('h2', {}, 'Filed'), field('Day', daySel)),
      sets.length ? sets.map((s) => filedCard(data, s, links)) : empty('Nothing filed that day.'));
  }

  // ---------------------------------------------------------------- Set aside
  async function renderAside() {
    mount(panel, h('p', { class: 'muted' }, 'Loading…'));
    await loadOverview();
    const days = (overview.days || []).filter((x) => x.set_aside > 0).map((x) => x.day);
    const loaded = [];
    for (const day of days) loaded.push(await dayData(day, { fresh: true }));
    const sets = loaded.flatMap((data) => data.sets.filter((s) => s.status === 'set_aside').map((s) => ({ data, s })));
    const links = await thumbLinks(loaded.flatMap((x) => x.items.filter((i) => sets.some(({ s }) => s.set_id === i.set_id))));
    mount(panel, h('h2', {}, 'Set aside'), h('p', { class: 'muted' }, 'Photos marked "Not a patient photo" or taken out of a filed set. They are kept; "Put back" sends them to "Which patient?".'),
      sets.length ? sets.map(({ data, s }) => h('article', { class: 'inbox-card' },
        h('div', { class: 'inbox-card-head' }, h('strong', {}, `${dayLabel(data.day)} · ${clockRange(s.first_at, s.last_at)} · ${plural(s.photo_count, 'photo')}`),
          h('span', { class: 'muted' }, ` · ${s.set_aside_reason === 'taken_out' ? 'Taken out of a filed set' : 'Not a patient photo'}`)),
        strip_(data.items.filter((i) => i.set_id === s.set_id).sort((a, b) => a.position - b.position), links, s),
        h('button', { type: 'button', class: 'btn', onclick: busy(async () => { try { await d.photoInboxPutBack(s.set_id); toast('Put back on "Which patient?".', 'ok'); refreshCounts(); showTab('aside'); } catch (e) { reloadAfter(e); } }) }, 'Put back')))
        : empty('Nothing is set aside.'));
  }

  async function showTab(id) {
    currentTab = id;
    strip.setCurrent(id);
    try {
      if (id === 'upload') await renderUpload();
      else if (id === 'which') await renderWhich();
      else if (id === 'filed') await renderFiled();
      else await renderAside();
    } catch (e) {
      mount(panel, h('div', { class: 'alert alert-warning', role: 'alert' }, friendlyError(e)));
    }
  }

  // ---------------------------------------------------------------- Claude editing (while the page is open)
  // The worker holds the photos it works on with a token of this page (two pages of one login share the work), renews the hold while it
  // works, and never gives up on a photo because of the connection: downloads, uploads and saves are tried again after a pause, and a
  // photo whose download fails is simply left for the next round (no try used up). Only a photo that cannot be read or stored is reported.
  // It stops with a clear message when the key is refused, the Anthropic credit is used up or the setup is wrong; while the key is
  // missing (or the check did not get through) it asks again every few minutes.
  let workerRunning = false;
  let editedNow = 0;
  let poke = null; // ends the worker's wait at once (a batch was uploaded)
  const lease = TAB_LEASE;
  let heicOk = canHeic(); // false after this browser failed to decode an iPhone HEIC photo once
  const nap = (ms) => new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); poke = null; resolve(); }
    poke = done;
    signal?.addEventListener('abort', done, { once: true });
  });
  const banner = (text, kind = 'info') => mount(aiBanner, text ? h('div', { class: `alert alert-${kind}` }, text) : null);
  const WAIT_KEY = 'Editing waits for the AI key. The photos are uploaded and filed; Claude edits them as soon as Dr. Ali adds the key.';
  const STOPS = {
    BAD_KEY: 'Editing stopped: the AI key was refused. Dr. Ali: check it in Supabase -> Edge Functions -> Secrets (ANTHROPIC_API_KEY), then reload this page.',
    BILLING: 'Editing stopped: the Anthropic account has no credit left. Dr. Ali: console.anthropic.com -> Billing (add credit), then reload this page. The photos are safe and filed; nothing was edited badly.',
    CONFIG: 'Editing stopped: Claude refused the request setup (model or size). Tell the website maintainer; the photos are safe and filed.',
  };
  /** A photo's original as a Blob, tried again after connection problems; null when it cannot be had just now. */
  async function original(it, originals) {
    let blob = originals.get(it.item_id);
    if (blob) return blob;
    try { blob = await withRetry(() => d.photoBlob(it.storage_path), signal, [5, 15]); } catch { return null; }
    originals.set(it.item_id, blob);
    return blob;
  }
  /** The photo could not be decoded: HEIC waits for Safari (this page stops claiming HEIC after one failure), anything else is a try. */
  async function cannotDecode(it) {
    const heic = /hei[cf]/i.test(it.mime_type || '');
    if (heic) heicOk = false;
    await withRetry(() => d.photoInboxEditFailed(it.item_id, heic ? 'HEIC_DECODE' : 'DECODE', lease), signal).catch(() => {});
  }
  /** Claude's numbers for the photos (and the reference photo of the set first, for the one-sitting check). */
  async function analyze(setId, list, originals, ref = null) {
    const copies = [];
    if (ref) {
      const blob = await original(ref, originals);
      const bmp = blob ? await decode(blob) : null;
      if (bmp) { try { copies.push({ item_id: ref.item_id, reference: true, ...(await aiCopy(bmp)) }); } finally { bmp.close?.(); } }
    }
    const sent = [];
    for (const it of list) {
      const blob = await original(it, originals);
      if (!blob) continue; // the connection: next round
      const bmp = await decode(blob);
      if (!bmp) { await cannotDecode(it); continue; }
      try { copies.push({ item_id: it.item_id, ...(await aiCopy(bmp)) }); sent.push(it); } finally { bmp.close?.(); }
    }
    if (!sent.length) return { ok: true, progress: false };
    const res = await d.photoAiAnalyze(setId, copies);
    if (res?.ok && res.status === 'truncated' && sent.length > 1) {
      const half = Math.ceil(sent.length / 2);
      const a = await analyze(setId, sent.slice(0, half), originals, ref);
      if (!a.ok) return a;
      return analyze(setId, sent.slice(half), originals, sent[half - 1]);
    }
    // ('skipped': another page had answered for these photos already)
    return res?.ok ? { ok: true, progress: res.status !== 'skipped' } : { ok: false, code: res?.code || 'SERVER', retry_after: res?.retry_after, items: sent };
  }
  /** One photo edited from its original and saved. Answers true when it was saved. */
  async function editOne(it, originals, { basic = false } = {}) {
    const blob = await original(it, originals);
    if (!blob) return false; // the connection: the hold runs out and the photo comes back later
    const bmp = await decode(blob);
    if (!bmp) { await cannotDecode(it); return false; }
    const ai = !basic && it.ai_status === 'done' ? it.ai_result : null;
    let out;
    try { out = await renderEdit(bmp, ai); } catch (e) {
      if (e.code === 'CANVAS') throw e; // short of picture memory: the worker pauses, nothing is counted
      await withRetry(() => d.photoInboxEditFailed(it.item_id, 'DECODE', lease), signal).catch(() => {});
      return false;
    } finally { bmp.close?.(); }
    const dir = it.storage_path.slice(0, it.storage_path.lastIndexOf('/') + 1);
    const round = Number(it.edit_round) > 1 ? `-r${Number(it.edit_round)}` : '';
    const path = `${dir}edited/${it.sha256}${round}.jpg`;
    const thumbPath = `${dir}edited/thumbs/${it.sha256}${round}.jpg`;
    try {
      const up = await withRetry(() => d.photoInboxUploadEdit({ path, thumbPath, blob: out.blob, thumb: out.thumb }), signal);
      await withRetry(() => d.photoInboxSaveEdit({ itemId: it.item_id, editedPath: path, editedThumbPath: up.thumbPath, editVersion: EDIT_VERSION, basic: !ai, lease }), signal);
      editedNow++;
      return true;
    } catch (e) {
      if (e.code === 'STORAGE_FULL') throw e;
      if (isConnectionProblem(e) || isCode(e, 'PHOTO_SET_STATE')) return false; // tried again later / another page has it
      await withRetry(() => d.photoInboxEditFailed(it.item_id, 'UPLOAD', lease), signal).catch(() => {});
      return false;
    }
  }
  /** Whether Claude editing is set up: true, false, or null (not known just now). Shows the waiting message. */
  async function keyReady() {
    let st;
    try { st = await d.photoAiStatus(); } catch { st = { key: null }; }
    aiKey = st.key === null ? aiKey : !!st.key;
    if (st.key === true) return true;
    if (st.key === false) {
      banner(st.code === 'NOT_DEPLOYED' ? 'Editing waits for the AI key. The photos are uploaded and filed; Claude edits them as soon as Dr. Ali sets up the photo-ai function and adds the key.' : WAIT_KEY);
      return false;
    }
    banner('Editing could not check the AI setup just now (connection). It tries again in a minute; the photos are safe.');
    return null;
  }
  async function startWorker() {
    if (workerRunning || signal?.aborted) return;
    workerRunning = true;
    try {
      let ready = await keyReady();
      let failures = 0;
      let idle = 0;
      while (!signal?.aborted) {
        if (ready !== true) { await nap(ready === false ? 5 * 60000 : 60000); ready = await keyReady(); continue; }
        if (document.visibilityState === 'hidden' || uploading) { await nap(5000); continue; }
        let progress = false;
        try {
          let claimed = await withRetry(() => d.photoInboxClaimEdits(AI_CHUNK, heicOk, lease), signal);
          if (!claimed.length) {
            const ai = overview?.ai || {};
            if (editedNow || (idle === 0 && (overview?.days || []).some((x) => x.items > 0))) {
              banner(ai.needs_safari ? `${plural(ai.needs_safari, 'iPhone HEIC photo')} can only be edited from Safari (iPhone or Mac); all the others are edited.` : 'All photos edited.');
            }
            if (editedNow) { editedNow = 0; refreshCounts(); }
            idle++;
            await nap(60000);
            loadOverview().catch(() => {});
            continue;
          }
          idle = 0;
          banner(`Editing photos: ${editedNow} edited so far. Keep this page open.`);
          const originals = new Map();
          const first = claimed[0];
          const ref = first.ref_item_id ? { item_id: first.ref_item_id, storage_path: first.ref_storage_path, mime_type: first.ref_mime_type } : null;
          // (with a reference photo, one place of the call is taken by it)
          const pending = claimed.filter((i) => i.ai_status === 'pending').slice(0, ref ? AI_CHUNK - 1 : AI_CHUNK);
          if (pending.length) {
            const r = await analyze(first.set_id, pending, originals, ref);
            if (!r.ok) {
              if (STOPS[r.code]) { banner(STOPS[r.code], 'warning'); return; }
              if (r.code === 'NO_KEY' || r.code === 'NOT_DEPLOYED') { aiKey = false; ready = false; banner(WAIT_KEY); continue; }
              if (r.code !== 'BAD_BODY') {
                // a rate limit, Anthropic down, the connection, or Anthropic refusing the request (that one counts as one of the photo's 3
                // tries): wait and try again; nothing else is counted against the photos
                failures++;
                await nap(r.code === 'RATE_LIMIT' ? (r.retry_after || 30) * 1000 : [20000, 60000, 300000][Math.min(failures, 3) - 1]);
                continue;
              }
              // this page could not send these photos to Claude at all: a basic edit (the Filed list offers "Try Claude again")
              for (const it of r.items || []) progress = (await editOne(it, originals, { basic: true })) || progress;
              claimed = [];
            } else {
              failures = 0;
              progress = progress || r.progress;
              await withRetry(() => d.photoInboxRenewEdits(claimed.map((i) => i.item_id), lease), signal).catch(() => {});
              claimed = await withRetry(() => d.photoInboxClaimEdits(AI_CHUNK, heicOk, lease), signal);
            }
          }
          for (const it of claimed) {
            if (signal?.aborted) return;
            if (it.ai_status === 'pending') continue; // Claude has not answered for it yet: next round
            progress = (await editOne(it, originals)) || progress;
          }
          banner(`Editing photos: ${editedNow} edited so far. Keep this page open.`);
        } catch (e) {
          if (e.code === 'STORAGE_FULL') { banner(friendlyError(e), 'warning'); return; }
          banner(e.code === 'CANVAS' ? 'Editing paused: this browser is short of memory for pictures. It goes on in a minute; the photos are safe.'
            : `Editing paused: ${friendlyError(e)} It goes on in a minute; the photos are safe.`, 'warning');
          await nap(60000);
          continue;
        }
        // a round that edited nothing (photos not readable here, the connection): a pause, so the page never loops on the same photos
        if (!progress) await nap(30000);
        // the Filed list shows the editing as it goes (unless someone is using it)
        else if (currentTab === 'filed' && !panel.contains(document.activeElement) && !document.querySelector('.modal')) renderFiled().catch(() => {});
      }
    } finally { workerRunning = false; }
  }

  // ---------------------------------------------------------------- the cost (Dr. Ali and accounts)
  async function drawCosts() {
    if (!(isAdmin() || can('finance.view')) || !d.photoAiCosts) return;
    try {
      const months = await d.photoAiCosts();
      const now = todayISO().slice(0, 7);
      const m = months.find((x) => x.month === now);
      mount(costLine, h('p', { class: 'muted' }, `AI editing this month: $${Number(m?.cost_usd || 0).toFixed(2)} (${plural(Number(m?.photos || 0), 'photo')}).`),
        months.length ? h('details', {}, h('summary', {}, 'Cost by month'), h('div', { class: 'table-scroll' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, ['Month', 'Calls', 'Photos', 'Refused', 'Cost (US $)'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, months.map((x) => h('tr', {}, h('td', {}, x.month), h('td', {}, x.calls), h('td', {}, x.photos), h('td', {}, x.refused), h('td', {}, Number(x.cost_usd).toFixed(2)))))))) : null);
    } catch { /* not shown */ }
  }

  // ---------------------------------------------------------------- start
  await showTab(currentTab);
  refreshCounts();
  drawCosts();
  startWorker();
  // Matching again every 3 minutes while the page is open and visible (statuses put right later on the Aaj ki List are picked up).
  const timer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || uploading) return;
    try {
      const ov = await loadOverview();
      for (const day of ov.waiting_days || []) await matchDay(day);
      refreshCounts();
      if (currentTab === 'which' && !panel.contains(document.activeElement)) renderWhich();
    } catch { /* tried again in 3 minutes */ }
  }, REMATCH_MS);
  signal?.addEventListener('abort', () => clearInterval(timer), { once: true });
}

