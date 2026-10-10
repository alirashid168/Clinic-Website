// Permission grid: rows = features, columns = roles. Mirrors the seed in
// supabase/migrations/..._seed_reference_data.sql. The database enforces it;
// the website uses it to hide buttons people can't use.

export const ROLES = ['front_desk', 'assistant', 'doctor', 'coordinator', 'accountant', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  front_desk: 'Front desk',
  assistant: 'Assistant',
  doctor: 'Doctor',
  coordinator: 'Clinic coordinator',
  accountant: 'Accountant',
  admin: 'Admin (Dr. Ali)',
};

export interface PermissionDef {
  key: string;
  label: string;
  category: string;
  // defaults for: front_desk, assistant, doctor, coordinator, accountant (admin always true)
  defaults: [boolean, boolean, boolean, boolean, boolean];
}

const Y = true;
const N = false;

export const PERMISSIONS: PermissionDef[] = [
  { key: 'patients.view', label: 'View patient profiles', category: 'Patients', defaults: [Y, Y, Y, Y, Y] },
  { key: 'patients.create', label: 'Register new patients (auto Mr#)', category: 'Patients', defaults: [Y, N, N, Y, N] },
  { key: 'patients.edit', label: 'Edit patient details', category: 'Patients', defaults: [Y, N, N, Y, N] },
  { key: 'portal.invite', label: 'Invite patients to the patient portal', category: 'Patients', defaults: [Y, N, N, Y, N] },
  { key: 'sheet.view', label: 'View Aaj ki List / queue', category: 'Daily list', defaults: [Y, Y, Y, Y, Y] },
  { key: 'sheet.edit', label: 'Add and edit Aaj ki List entries', category: 'Daily list', defaults: [Y, Y, Y, Y, N] },
  { key: 'treatment.enter', label: 'Enter treatment done / braces details', category: 'Daily list', defaults: [N, Y, Y, N, N] },
  { key: 'braces.manage', label: 'Manage braces cases (plan, extraction)', category: 'Braces', defaults: [N, N, Y, N, N] },
  { key: 'braces.override', label: 'Override braces protocol rules', category: 'Braces', defaults: [N, N, N, N, N] },
  { key: 'retainers.manage', label: 'Manage retainer cases', category: 'Braces', defaults: [N, Y, Y, Y, N] },
  { key: 'doctor_log.view_all', label: "See every doctor's daily log", category: 'Doctors', defaults: [N, N, N, Y, Y] },
  { key: 'photos.upload', label: 'Upload clinic photos and X-rays', category: 'Photos', defaults: [N, Y, Y, Y, N] },
  { key: 'photos.view_raw', label: 'View raw clinic photos folder', category: 'Photos', defaults: [N, Y, Y, Y, N] },
  { key: 'xrays.view', label: 'View X-rays', category: 'Photos', defaults: [Y, Y, Y, Y, N] },
  { key: 'dues.view', label: 'See $$ pending dues flag', category: 'Billing', defaults: [Y, Y, Y, Y, Y] },
  { key: 'dues.override', label: 'Override the dues hold', category: 'Billing', defaults: [N, N, N, N, Y] },
  { key: 'billing.view', label: 'View invoices and payments', category: 'Billing', defaults: [Y, N, N, Y, Y] },
  { key: 'billing.create', label: 'Create invoices and take payments', category: 'Billing', defaults: [Y, N, N, N, Y] },
  { key: 'billing.edit', label: 'Edit or void invoices', category: 'Billing', defaults: [N, N, N, N, Y] },
  { key: 'billing.refund', label: 'Give refunds', category: 'Billing', defaults: [N, N, N, N, Y] },
  { key: 'discount.give', label: 'Give discounts within cap', category: 'Billing', defaults: [Y, N, N, N, Y] },
  { key: 'discount.approve', label: 'Approve discounts above cap', category: 'Billing', defaults: [N, N, N, N, Y] },
  { key: 'cash.close', label: 'Daily cash closing', category: 'Accounts', defaults: [Y, N, N, N, N] },
  { key: 'cash.verify', label: 'Verify cash closing', category: 'Accounts', defaults: [N, N, N, N, Y] },
  { key: 'expenses.manage', label: 'Add and edit expenses', category: 'Accounts', defaults: [N, N, N, N, Y] },
  { key: 'finance.view', label: 'View all financial reports', category: 'Accounts', defaults: [N, N, N, N, Y] },
  { key: 'branch_revenue.view', label: 'View own branch revenue', category: 'Accounts', defaults: [N, N, N, N, Y] },
  { key: 'commission.view_own', label: 'See own doctor percentage', category: 'Accounts', defaults: [N, N, Y, N, N] },
  { key: 'commission.view_all', label: 'See all doctor percentages', category: 'Accounts', defaults: [N, N, N, N, Y] },
  { key: 'commission.manage', label: 'Set doctor percentage rules', category: 'Accounts', defaults: [N, N, N, N, Y] },
  { key: 'lab.manage', label: 'Lab work entries', category: 'Coordinator', defaults: [N, Y, N, Y, N] },
  { key: 'reminders.manage', label: 'Follow-up reminders and drop-off list', category: 'Coordinator', defaults: [Y, N, N, Y, N] },
  { key: 'complaints.view', label: 'Complaints inbox', category: 'Coordinator', defaults: [N, N, N, Y, N] },
  { key: 'flags.raise', label: 'Flag patient for Dr. Ali', category: 'Coordinator', defaults: [Y, Y, Y, Y, Y] },
  { key: 'flags.clear', label: 'Clear Dr. Ali flag', category: 'Coordinator', defaults: [N, N, N, N, N] },
  { key: 'schedule.manage', label: "Edit Dr. Ali's calendar", category: 'Coordinator', defaults: [N, N, N, Y, N] },
  { key: 'inventory.manage', label: 'Inventory', category: 'Operations', defaults: [N, Y, N, Y, Y] },
  { key: 'export.data', label: 'Export / download data', category: 'Admin', defaults: [N, N, N, N, Y] },
  { key: 'settings.manage', label: 'Treatments, templates and settings', category: 'Admin', defaults: [N, N, N, N, N] },
  { key: 'users.manage', label: 'Manage users and permissions', category: 'Admin', defaults: [N, N, N, N, N] },
  { key: 'audit.view', label: 'Audit log', category: 'Admin', defaults: [N, N, N, N, N] },
];

export type PermissionKey = string;

export function defaultAllowed(role: Role, key: PermissionKey): boolean {
  if (role === 'admin') return true;
  const def = PERMISSIONS.find((p) => p.key === key);
  if (!def) return false;
  return def.defaults[ROLES.indexOf(role)];
}

export type Grid = Record<Role, Record<PermissionKey, boolean>>;

export function defaultGrid(): Grid {
  const grid = {} as Grid;
  for (const role of ROLES) {
    grid[role] = {};
    for (const p of PERMISSIONS) grid[role][p.key] = defaultAllowed(role, p.key);
  }
  return grid;
}

/** Same rule as public.has_perm(): admin always; personal override beats role setting. */
export function hasPermission(
  role: Role | null,
  key: PermissionKey,
  grid: Grid,
  overrides: Record<PermissionKey, boolean> = {},
): boolean {
  if (!role) return false;
  if (role === 'admin') return true;
  if (key in overrides) return overrides[key];
  return grid[role]?.[key] ?? false;
}

// ---------------------------------------------------------------------------
// Discount caps
// ---------------------------------------------------------------------------
export interface DiscountCap { maxPercent: number | null; maxAmount: number | null }

export function discountNeedsApproval(
  role: Role,
  subtotal: number,
  discount: number,
  cap: DiscountCap | undefined,
  canApprove: boolean,
): boolean {
  if (discount <= 0 || role === 'admin' || canApprove) return false;
  if (!cap) return true;
  const pct = subtotal > 0 ? (discount * 100) / subtotal : 100;
  return (cap.maxPercent !== null && pct > cap.maxPercent) || (cap.maxAmount !== null && discount > cap.maxAmount);
}
