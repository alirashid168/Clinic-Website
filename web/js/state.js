// Shared app state: the data layer, who is logged in, and cached reference
// lists (branches, doctors, treatments) used across screens.
import { getData } from './data/index.js';

export const state = {
  data: null,
  session: null,
  ref: { branches: [], cities: [], clinicians: [], treatments: [], categories: [], settings: {} },
};

export async function init() {
  state.data = await getData();
  try { state.session = await state.data.getSession(); } catch { state.session = null; }
  await loadPublicRef();
}

export async function loadPublicRef() {
  const d = state.data;
  const [branches, cities, settings] = await Promise.all([d.branches(), d.cities(), d.settings().catch(() => ({}))]);
  Object.assign(state.ref, { branches, cities, settings });
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
