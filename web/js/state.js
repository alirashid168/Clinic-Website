// Shared app state: the data layer, who is logged in, and cached reference
// lists (branches, doctors, treatments) used across screens.
//
// Loading starts as soon as this file runs. `state.ready` resolves when it is
// done and never rejects: if the data layer or the public lists fail to load,
// `state.dataError` holds the error and the lists stay empty, so the public
// pages can still show their own wording and a way to contact the clinic.
import { getData } from './data/index.js';

export const state = {
  data: null,
  session: null,
  ready: null,
  dataError: null,
  ref: { branches: [], cities: [], clinicians: [], treatments: [], categories: [], settings: {} },
};

let readyPromise;

/** Starts loading (once) and returns state.ready. */
export function init() {
  if (!readyPromise) readyPromise = start();
  return readyPromise;
}

async function start() {
  try {
    state.data = await getData();
    // Who is logged in and the public lists load side by side.
    const [session, ref] = await Promise.allSettled([state.data.getSession(), loadPublicRef()]);
    state.session = session.status === 'fulfilled' ? session.value : null;
    if (ref.status === 'rejected') throw ref.reason;
  } catch (e) {
    console.error(e);
    state.dataError = e instanceof Error ? e : new Error(String(e));
  }
}

export async function loadPublicRef() {
  const d = state.data;
  // Settings hold the clinic timings and the WhatsApp number: without them the
  // public pages would show confident but wrong text, so a failure counts as a failure.
  const [branches, cities, settings] = await Promise.all([d.branches(), d.cities(), d.settings()]);
  Object.assign(state.ref, { branches, cities, settings: settings || {} });
}

export async function loadStaffRef() {
  const d = state.data;
  const [clinicians, treatments, categories, settings] = await Promise.all([
    d.clinicians(), d.treatments(), d.expenseCategories().catch(() => []), d.settings().catch(() => ({})),
  ]);
  Object.assign(state.ref, { clinicians, treatments, categories, settings });
}

export const can = (key) => !!state.session?.perms?.has(key) || state.session?.staff?.role === 'admin';
export const isAdmin = () => state.session?.staff?.role === 'admin';
export const branchName = (id) => state.ref.branches.find((b) => b.id === Number(id))?.name || '';
export const cityName = (id) => state.ref.cities.find((c) => c.id === Number(id))?.name || '';
export const clinicianName = (id) => state.ref.clinicians.find((c) => c.id === id)?.display_name || '';

/** Branches this staff member may work in (front desk is usually one branch). */
export function myBranches() {
  const s = state.session?.staff;
  if (!s) return [];
  if (s.role !== 'admin' && s.restrict_to_branches) return state.ref.branches.filter((b) => s.branch_ids.includes(b.id));
  return state.ref.branches;
}

export function defaultBranchId() {
  const s = state.session?.staff;
  const mine = myBranches();
  return Number(s?.home_branch_id) || mine[0]?.id || null;
}

state.ready = init();
