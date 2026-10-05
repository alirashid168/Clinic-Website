-- =====================================================================
-- Dr. Ali Rashid's Dental Clinic: core schema
-- Branches, staff, permissions, patients (auto Mr#), visits, braces
-- protocol, retainers, billing, expenses, complaints, flags, lab work,
-- inventory, calendar, audit log.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.staff_role as enum
  ('front_desk', 'assistant', 'doctor', 'coordinator', 'accountant', 'admin');

create type public.visit_status as enum
  ('scheduled', 'waiting', 'in_treatment', 'completed', 'cancelled', 'no_show');

create type public.visit_staff_role as enum ('doctor', 'assistant', 'checker');

create type public.extraction_plan as enum ('undecided', 'extraction', 'non_extraction');

create type public.braces_case_status as enum
  ('active', 'debonded', 'discontinued');

create type public.retainer_stage as enum
  ('impression', 'fabrication', 'ready', 'delivered', 'follow_up', 'replacement_needed', 'closed');

create type public.payment_method as enum ('cash', 'bank_transfer', 'card', 'cheque', 'other');

create type public.invoice_status as enum ('draft', 'pending_approval', 'issued', 'void');

create type public.approval_status as enum ('pending', 'approved', 'rejected');

create type public.complaint_status as enum ('new', 'in_progress', 'resolved');

create type public.lab_status as enum ('sent', 'received', 'fitted', 'returned', 'cancelled');

create type public.reminder_kind as enum
  ('followup', 'appointment', 'installment', 'retainer', 'lab', 'recall', 'dues');

create type public.reminder_status as enum
  ('open', 'contacted', 'no_answer', 'booked', 'done', 'cancelled');

create type public.photo_kind as enum ('raw', 'edited');

-- ---------------------------------------------------------------------
-- Settings (key/value, admin-editable)
-- ---------------------------------------------------------------------
create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------
create table public.cities (
  id   smallint generated always as identity primary key,
  name text not null unique
);

create table public.branches (
  id             smallint generated always as identity primary key,
  code           text not null unique,          -- short code, e.g. 'NN', 'GUL', 'DHA', 'ISB'
  name           text not null,
  city_id        smallint not null references public.cities(id),
  address        text,
  phone          text,
  active         boolean not null default true,
  sort_order     smallint not null default 0,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Doctor groups (braces protocol)
-- ---------------------------------------------------------------------
create table public.doctor_groups (
  id          smallint primary key,               -- 1, 2, 3
  name        text not null,
  description text
);

-- ---------------------------------------------------------------------
-- Staff (one row per staff login; id = auth.users.id)
-- ---------------------------------------------------------------------
create table public.staff (
  id                 uuid primary key,             -- references auth.users(id) (FK added in auth migration)
  full_name          text not null,
  email              text not null unique,         -- name@dralirashid.com
  phone              text,
  role               public.staff_role not null,
  doctor_group_id    smallint references public.doctor_groups(id),
  home_branch_id     smallint references public.branches(id),
  restrict_to_branches boolean not null default false,
  branch_ids         smallint[] not null default '{}',  -- branches allowed when restricted
  active             boolean not null default true,
  deactivated_at     timestamptz,
  deactivated_by     uuid,
  created_at         timestamptz not null default now(),
  constraint doctor_group_only_for_doctors
    check (doctor_group_id is null or role in ('doctor', 'admin'))
);

-- People who appear on visits but don't (yet) have a login, e.g. imported
-- doctors from old sheets. Linked to staff once they get an account.
create table public.clinicians (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null unique,            -- 'Dr. Samrah Khan'
  aliases         text[] not null default '{}',    -- spellings seen in old sheets
  is_doctor       boolean not null default true,
  doctor_group_id smallint references public.doctor_groups(id),
  region          text,                            -- 'KHI', 'LHR', 'ISB'
  staff_id        uuid unique references public.staff(id),
  active          boolean not null default true
);

-- ---------------------------------------------------------------------
-- Permissions (checkbox grid)
-- ---------------------------------------------------------------------
create table public.permissions (
  key         text primary key,
  label       text not null,
  category    text not null,
  sort_order  smallint not null default 0,
  description text
);

create table public.role_permissions (
  role           public.staff_role not null,
  permission_key text not null references public.permissions(key) on delete cascade,
  allowed        boolean not null default false,
  primary key (role, permission_key)
);

create table public.staff_permission_overrides (
  staff_id       uuid not null references public.staff(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  allowed        boolean not null,
  primary key (staff_id, permission_key)
);

create table public.discount_caps (
  role        public.staff_role primary key,
  max_percent numeric(5,2),          -- null = no % limit
  max_amount  numeric(12,2),         -- null = no rupee limit
  check (max_percent is null or (max_percent >= 0 and max_percent <= 100)),
  check (max_amount is null or max_amount >= 0)
);

-- ---------------------------------------------------------------------
-- Patients and Mr#
-- ---------------------------------------------------------------------
-- New Mr# values continue after the highest existing numeric Mr#.
-- The starting value is reset by public.sync_mr_sequence() after migration.
create sequence public.mr_number_seq start with 10000;

create table public.patients (
  id                    uuid primary key default gen_random_uuid(),
  mr_number             text not null unique,
  full_name             text not null,
  phone                 text not null,
  phone_alt             text,
  email                 text,
  gender                text check (gender in ('female', 'male', 'other')),
  date_of_birth         date,
  address               text,
  city_id               smallint references public.cities(id),
  first_branch_id       smallint references public.branches(id),
  referral_source       text,                     -- Instagram, Referral, Walk-in, Google ...
  referred_by_clinician uuid references public.clinicians(id),
  medical_history       jsonb not null default '{}'::jsonb,
  treatment_consent_at  timestamptz,
  photo_consent_public  boolean not null default false,
  photo_consent_at      timestamptz,
  portal_user_id        uuid unique,              -- auth.users id for the patient portal
  notes                 text,
  legacy_source         text,                     -- 'healthwire', 'aaj_ki_list', 'drive'
  legacy_name           text,                     -- name as it appeared before cleanup, e.g. 'Sana lhr'
  created_at            timestamptz not null default now(),
  created_by            uuid,
  updated_at            timestamptz not null default now(),
  constraint phone_not_blank check (length(btrim(phone)) >= 7),
  constraint name_not_blank check (length(btrim(full_name)) >= 2)
);

create index patients_name_idx on public.patients (lower(full_name));
create index patients_phone_idx on public.patients (phone);

-- ---------------------------------------------------------------------
-- Treatment catalogue (dropdown + default prices)
-- ---------------------------------------------------------------------
create table public.treatments (
  id            smallint generated always as identity primary key,
  name          text not null unique,
  category      text not null,               -- braces, retainer, general, cosmetic, surgery, diagnostic
  default_price numeric(12,2),
  is_braces_monthly boolean not null default false,
  active        boolean not null default true,
  sort_order    smallint not null default 0
);

-- ---------------------------------------------------------------------
-- Braces protocol (month-by-month rules from the Braces Treatment Module)
-- ---------------------------------------------------------------------
create table public.braces_protocol (
  month                   smallint primary key check (month between 1 and 60),
  treating_groups         smallint[] not null,       -- groups allowed to treat
  checker_group           smallint references public.doctor_groups(id),
  planned_wire            text,                      -- 'O12', 'O14', 'O16' ...
  photo_required          boolean not null default false,
  requires_dr_ali_plan    boolean not null default false,
  extraction_decision     boolean not null default false,  -- month 4
  extraction_deadline     boolean not null default false,  -- month 7: no extractions after
  dues_checkpoint         boolean not null default false,  -- months 8, 15
  retainer_payment_reminder boolean not null default false,
  ends_non_extraction     boolean not null default false,  -- months 10/12
  ends_extraction         boolean not null default false,  -- month 18
  instructions            text[] not null default '{}',
  confirmed               boolean not null default true    -- false = still [TO CONFIRM] with Dr. Ali
);

create table public.braces_cases (
  id                    uuid primary key default gen_random_uuid(),
  patient_id            uuid not null references public.patients(id) on delete cascade,
  start_date            date not null,
  bonding_branch_id     smallint references public.branches(id),
  kit_name              text,                      -- '55k kit', '70k kit', '80k kit', '120k kit'
  total_fee             numeric(12,2),
  extraction_plan       public.extraction_plan not null default 'undecided',
  extraction_decided_at date,
  extractions_done      boolean not null default false,
  treatment_plan_by_dr_ali text,                   -- month 1 plan
  status                public.braces_case_status not null default 'active',
  debond_date           date,
  notes                 text,
  created_at            timestamptz not null default now(),
  created_by            uuid
);

create index braces_cases_patient_idx on public.braces_cases (patient_id);
create unique index braces_cases_one_active_idx
  on public.braces_cases (patient_id) where status = 'active';

-- ---------------------------------------------------------------------
-- Visits (one row per line in Aaj ki List)
-- ---------------------------------------------------------------------
create table public.visits (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.patients(id) on delete restrict,
  branch_id        smallint not null references public.branches(id),
  visit_date       date not null default current_date,
  token_no         integer,
  status           public.visit_status not null default 'waiting',
  treatment_id     smallint references public.treatments(id),
  treatment_label  text,                         -- free text when not in catalogue ('Monthly / Ext')
  braces_case_id   uuid references public.braces_cases(id),
  braces_month     smallint check (braces_month between 1 and 60),
  doctor_group_id  smallint references public.doctor_groups(id),
  details          jsonb not null default '{}'::jsonb,   -- structured: wires, power chain, brackets, extractions ...
  details_text     text,                         -- 'U L 018 Pc Refresh'
  notes            text,
  photo_required   boolean not null default false,
  photos_uploaded  boolean not null default false,
  checker_required boolean not null default false,
  checked_by       uuid references public.clinicians(id),
  checked_at       timestamptz,
  dues_at_checkin  numeric(12,2),
  dues_override_by uuid references public.staff(id),
  dues_override_reason text,
  protocol_override_by uuid references public.staff(id),
  protocol_override_reason text,
  checked_in_at    timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_by       uuid,
  updated_at       timestamptz not null default now(),
  legacy_source    text,
  constraint braces_month_needs_case check (braces_month is null or braces_case_id is not null)
);

create index visits_branch_date_idx on public.visits (branch_id, visit_date);
create index visits_patient_idx on public.visits (patient_id, visit_date desc);
create unique index visits_token_unique_idx
  on public.visits (branch_id, visit_date, token_no) where token_no is not null;

create table public.visit_staff (
  visit_id     uuid not null references public.visits(id) on delete cascade,
  clinician_id uuid not null references public.clinicians(id),
  role         public.visit_staff_role not null default 'doctor',
  primary key (visit_id, clinician_id, role)
);

-- ---------------------------------------------------------------------
-- Retainers (made in-house)
-- ---------------------------------------------------------------------
create table public.retainer_cases (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references public.patients(id) on delete cascade,
  braces_case_id   uuid references public.braces_cases(id),
  branch_id        smallint references public.branches(id),
  arch             text not null check (arch in ('upper', 'lower', 'both')),
  retainer_type    text,                        -- e.g. Essix / Hawley / fixed
  stage            public.retainer_stage not null default 'impression',
  impression_date  date,
  fabricated_date  date,
  ready_date       date,
  delivered_date   date,
  next_check_date  date,
  is_replacement   boolean not null default false,
  repeat_reason    text,
  lab_cost         numeric(12,2),
  price            numeric(12,2),
  notes            text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Billing: invoices, items, payments, installment plans, discounts
-- ---------------------------------------------------------------------
create sequence public.invoice_number_seq start with 1;

create table public.invoice_templates (
  key         text primary key,
  name        text not null,
  is_default  boolean not null default false,
  config      jsonb not null default '{}'::jsonb
);

create table public.invoices (
  id               uuid primary key default gen_random_uuid(),
  invoice_no       text not null unique,
  patient_id       uuid not null references public.patients(id) on delete restrict,
  branch_id        smallint not null references public.branches(id),
  visit_id         uuid references public.visits(id),
  braces_case_id   uuid references public.braces_cases(id),
  issue_date       date not null default current_date,
  subtotal         numeric(12,2) not null default 0 check (subtotal >= 0),
  discount_amount  numeric(12,2) not null default 0 check (discount_amount >= 0),
  total            numeric(12,2) generated always as (greatest(subtotal - discount_amount, 0)) stored,
  status           public.invoice_status not null default 'issued',
  discount_reason  text,
  discount_approved_by uuid references public.staff(id),
  template_key     text references public.invoice_templates(key),
  notes            text,
  void_reason      text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  legacy_source    text
);

create index invoices_patient_idx on public.invoices (patient_id);
create index invoices_branch_date_idx on public.invoices (branch_id, issue_date);

create table public.invoice_items (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references public.invoices(id) on delete cascade,
  treatment_id smallint references public.treatments(id),
  description  text not null,
  quantity     numeric(8,2) not null default 1 check (quantity > 0),
  unit_price   numeric(12,2) not null check (unit_price >= 0),
  line_total   numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored
);

create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patients(id) on delete restrict,
  invoice_id   uuid references public.invoices(id),
  branch_id    smallint not null references public.branches(id),
  amount       numeric(12,2) not null check (amount <> 0),   -- negative = refund
  method       public.payment_method not null default 'cash',
  received_at  timestamptz not null default now(),
  received_by  uuid,
  reference    text,
  notes        text,
  is_refund    boolean generated always as (amount < 0) stored,
  legacy_source text
);

create index payments_patient_idx on public.payments (patient_id);
create index payments_branch_date_idx on public.payments (branch_id, received_at);

create table public.payment_plans (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references public.patients(id) on delete cascade,
  braces_case_id uuid references public.braces_cases(id),
  total_fee      numeric(12,2) not null check (total_fee >= 0),
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now()
);

create table public.plan_installments (
  id        uuid primary key default gen_random_uuid(),
  plan_id   uuid not null references public.payment_plans(id) on delete cascade,
  due_date  date not null,
  amount    numeric(12,2) not null check (amount > 0),
  note      text
);

create table public.discount_requests (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  requested_by  uuid not null,
  discount_amount numeric(12,2) not null,
  reason        text,
  status        public.approval_status not null default 'pending',
  decided_by    uuid references public.staff(id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Expenses and cash closing
-- ---------------------------------------------------------------------
create table public.expense_categories (
  id         smallint generated always as identity primary key,
  name       text not null unique,
  active     boolean not null default true,
  sort_order smallint not null default 0
);

create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  expense_date  date not null default current_date,
  branch_id     smallint references public.branches(id),   -- null = city-level / head office
  city_id       smallint not null references public.cities(id),
  category_id   smallint not null references public.expense_categories(id),
  amount        numeric(12,2) not null check (amount > 0),
  paid_to       text,
  method        public.payment_method not null default 'cash',
  receipt_path  text,
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  legacy_source text
);

create index expenses_branch_date_idx on public.expenses (branch_id, expense_date);
create index expenses_city_date_idx on public.expenses (city_id, expense_date);

create table public.cash_closings (
  id             uuid primary key default gen_random_uuid(),
  branch_id      smallint not null references public.branches(id),
  closing_date   date not null,
  expected_cash  numeric(12,2) not null,
  counted_cash   numeric(12,2) not null,
  difference     numeric(12,2) generated always as (counted_cash - expected_cash) stored,
  closed_by      uuid not null,
  closed_at      timestamptz not null default now(),
  verified_by    uuid references public.staff(id),
  verified_at    timestamptz,
  notes          text,
  unique (branch_id, closing_date)
);

-- Doctor percentage rules: structure ready, rules to be taught by Dr. Ali.
create table public.doctor_commission_rules (
  id            uuid primary key default gen_random_uuid(),
  clinician_id  uuid references public.clinicians(id),    -- null = applies to all doctors
  basis         text not null check (basis in ('referred', 'treated', 'both')),
  percent       numeric(5,2) not null check (percent >= 0 and percent <= 100),
  treatment_category text,                                -- null = all treatments
  active        boolean not null default true,
  notes         text
);

-- ---------------------------------------------------------------------
-- Clinical media
-- ---------------------------------------------------------------------
create table public.photos (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid references public.patients(id) on delete cascade,   -- null until matched
  visit_id        uuid references public.visits(id) on delete set null,
  branch_id       smallint references public.branches(id),
  taken_on        date not null default current_date,
  kind            public.photo_kind not null default 'raw',
  view_label      text,             -- front, left, right, upper occlusal, lower occlusal
  braces_month    smallint,
  storage_path    text not null unique,
  edited_from     uuid references public.photos(id),
  public_ok       boolean not null default false,   -- patient consent for public use
  sent_to_patient_at timestamptz,
  uploaded_by     uuid,
  created_at      timestamptz not null default now()
);

create table public.xrays (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patients(id) on delete cascade,
  visit_id      uuid references public.visits(id) on delete set null,
  kind          text not null default 'OPG',
  taken_on      date not null default current_date,
  storage_path  text not null unique,
  notes         text,
  uploaded_by   uuid,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Coordinator: lab work, reminders
-- ---------------------------------------------------------------------
create table public.lab_cases (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patients(id) on delete cascade,
  visit_id      uuid references public.visits(id),
  branch_id     smallint not null references public.branches(id),
  lab_name      text not null,
  work_type     text not null,             -- crown, denture, veneer, retainer ...
  sent_date     date not null default current_date,
  due_date      date,
  received_date date,
  fitted_date   date,
  status        public.lab_status not null default 'sent',
  cost          numeric(12,2),
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.reminders (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patients(id) on delete cascade,
  branch_id    smallint references public.branches(id),
  kind         public.reminder_kind not null,
  due_date     date not null,
  note         text,
  status       public.reminder_status not null default 'open',
  assigned_to  uuid references public.staff(id),
  last_contacted_at timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index reminders_due_idx on public.reminders (status, due_date);

-- ---------------------------------------------------------------------
-- Complaints, flags, ratings
-- ---------------------------------------------------------------------
create table public.complaints (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid not null references public.patients(id) on delete cascade,
  branch_id     smallint references public.branches(id),
  clinician_id  uuid references public.clinicians(id),
  subject       text not null,
  body          text not null,
  status        public.complaint_status not null default 'new',
  created_at    timestamptz not null default now(),
  resolved_by   uuid references public.staff(id),
  resolved_at   timestamptz
);

create table public.complaint_messages (
  id            uuid primary key default gen_random_uuid(),
  complaint_id  uuid not null references public.complaints(id) on delete cascade,
  author_staff  uuid references public.staff(id),     -- null = written by patient
  body          text not null,
  internal_note boolean not null default false,       -- staff-only notes hidden from patient
  created_at    timestamptz not null default now()
);

-- "Please get your next appointment done by Dr. Ali Rashid"
create table public.patient_flags (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references public.patients(id) on delete cascade,
  kind        text not null default 'see_dr_ali' check (kind in ('see_dr_ali')),
  reason      text not null,
  raised_by   uuid not null,
  raised_at   timestamptz not null default now(),
  cleared_by  uuid,
  cleared_at  timestamptz,
  cleared_note text
);

create unique index patient_flags_one_active_idx
  on public.patient_flags (patient_id, kind) where cleared_at is null;

create table public.visit_ratings (
  visit_id    uuid primary key references public.visits(id) on delete cascade,
  patient_id  uuid not null references public.patients(id) on delete cascade,
  stars       smallint not null check (stars between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now(),
  followed_up_by uuid references public.staff(id),
  followed_up_at timestamptz
);

-- ---------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------
create table public.inventory_items (
  id        smallint generated always as identity primary key,
  name      text not null unique,
  category  text not null,          -- brackets, wires, elastics, bonding, consumables
  unit      text not null default 'pcs',
  supplier  text,
  active    boolean not null default true
);

create table public.inventory_stock (
  branch_id     smallint not null references public.branches(id),
  item_id       smallint not null references public.inventory_items(id),
  quantity      numeric(12,2) not null default 0,
  reorder_level numeric(12,2) not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (branch_id, item_id)
);

create table public.inventory_moves (
  id         uuid primary key default gen_random_uuid(),
  branch_id  smallint not null references public.branches(id),
  item_id    smallint not null references public.inventory_items(id),
  change     numeric(12,2) not null check (change <> 0),   -- + received, - used
  reason     text not null,                                -- received, used, adjustment, transfer
  visit_id   uuid references public.visits(id),
  created_by uuid,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Dr. Ali's public calendar
-- ---------------------------------------------------------------------
create table public.dr_ali_schedule (
  id          uuid primary key default gen_random_uuid(),
  branch_id   smallint not null references public.branches(id),
  weekday     smallint check (weekday between 0 and 6),   -- recurring (0 = Sunday)
  on_date     date,                                         -- one-off / exception
  start_time  time not null,
  end_time    time not null,
  unavailable boolean not null default false,               -- one-off cancellation
  note        text,
  check (weekday is not null or on_date is not null),
  check (end_time > start_time)
);

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  row_id      text,
  action      text not null,        -- INSERT / UPDATE / DELETE / custom
  old_data    jsonb,
  new_data    jsonb,
  actor       uuid,
  at          timestamptz not null default now()
);

create index audit_log_table_row_idx on public.audit_log (table_name, row_id);
create index audit_log_at_idx on public.audit_log (at desc);
