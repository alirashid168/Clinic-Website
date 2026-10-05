-- =====================================================================
-- Reference data: settings, branches, doctor groups, clinicians,
-- permission grid defaults, treatments, braces protocol, templates.
-- Items marked TO CONFIRM are placeholders until Dr. Ali confirms them.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description) values
  ('dues_hold_mode', '"warn"',
   'warn = show "Clear dues first" but allow treatment; block = stop treatment until dues are cleared or overridden; block_at_checkpoints = block only at braces dues months (8, 15). TO CONFIRM with Dr. Ali.'),
  ('dropoff_days', '42', 'Braces patients not seen for this many days appear on the drop-off list.'),
  ('low_rating_threshold', '3', 'Ratings at or below this alert the clinic coordinator.'),
  ('clinic_timings', '{"mon":"12:00-21:00","tue":"12:00-21:00","wed":"12:00-21:00","thu":"12:00-21:00","fri":"15:00-21:00","sat":"12:00-21:00"}',
   'Clinic opening hours shown on the website.'),
  ('whatsapp_number', '""', 'Official WhatsApp Business number for the "Book free consultation" button. TO FILL.'),
  ('session_timeout_minutes', '30', 'Staff are logged out after this many minutes of inactivity.');

-- ---------------------------------------------------------------------
-- Cities and branches (current five clinics)
-- ---------------------------------------------------------------------
insert into public.cities (name) values ('Karachi'), ('Lahore'), ('Islamabad');

insert into public.branches (code, name, city_id, address, sort_order) values
  ('GUL', 'Gulshan (RJ Mall)', (select id from public.cities where name = 'Karachi'),
   'RJ Mall, 3rd Floor, Gulshan-e-Iqbal, Karachi', 1),
  ('NN',  'North Nazimabad',   (select id from public.cities where name = 'Karachi'),
   'Block M, North Nazimabad, Karachi', 2),
  ('DHA', 'DHA Karachi',       (select id from public.cities where name = 'Karachi'),
   'Bukhari Commercial, DHA Phase 6, Karachi', 3),
  ('LHR', 'Gulberg Lahore',    (select id from public.cities where name = 'Lahore'),
   'Al Hafeez Business Avenue, Office 510-512, Gulberg 3, Lahore', 4),
  ('ISB', 'Islamabad',         (select id from public.cities where name = 'Islamabad'),
   'Giga Downtown, DHA Phase II, Islamabad', 5);

-- ---------------------------------------------------------------------
-- Doctor groups and clinicians (from the Braces Treatment Module)
-- ---------------------------------------------------------------------
insert into public.doctor_groups (id, name, description) values
  (1, 'Group 1', 'Senior: photo months, extraction decisions, checks Group 1 months'),
  (2, 'Group 2', 'Checks Group 3 months; treats months 4, 7, 10, 13, 18 with Group 1'),
  (3, 'Group 3', 'Routine monthly visits (Karachi and Lahore teams)');

insert into public.clinicians (display_name, aliases, is_doctor, doctor_group_id, region) values
  ('Dr. Ali Rashid',     '{"Dr Ali Rashid","Dr. Ali Rashid"}', true, null, null),
  ('Dr. Komal Rubab',    '{"Dr Komal","Dr. Komal"}', true, 1, 'KHI'),
  ('Dr. Samrah Khan',    '{"Dr Samrah Khan","Dr. Samrah"}', true, 1, 'KHI'),
  ('Dr. Warda Javed',    '{"Dr Warda Javed","Dr. Verda Javed","Dr Verda","Dr Verda Javed"}', true, 1, null),
  ('Dr. Urooj Jawed',    '{"Dr Urooj Jawed","Dr. Urooj Javed","Dr Urooj Javed"}', true, 2, 'KHI'),
  ('Dr. Mehwish Saleem', '{"Dr Mehwish Saleem"}', true, 2, 'KHI'),
  ('Dr. Maheen Fatima',  '{"Dr Maheen Fatima"}', true, 2, null),
  ('Dr. Kainat Waheed',  '{"Dr Kainat Waheed"}', true, 2, null),
  ('Dr. Hameeda Sharaf', '{"Dr Hameeda","Dr. Hameeda"}', true, 3, 'KHI'),
  ('Dr. Haniya Siddiqui','{"Dr Haniya","Dr. Haniya"}', true, 3, 'KHI'),
  ('Dr. Mirha Siddiq',   '{"Dr Mirha","Dr. Mirha"}', true, 3, 'KHI'),
  ('Dr. Laiba Khan',     '{"Dr Laiba Khan"}', true, 3, 'KHI'),
  ('Dr. Vaneeza Khan',   '{"Dr Vaneeza Khan"}', true, 3, 'LHR'),
  ('Dr. Duaa Nusrat',    '{"Dr Duaa Nusrat"}', true, 3, 'LHR'),
  ('Dr. Zunash Suhail',  '{"Dr Zunash Suhail"}', true, 3, 'LHR'),
  ('Dr. Rida Jameel',    '{"Dr Rida Jameel"}', true, 3, 'LHR'),
  -- Seen in Aaj ki List but not in any group yet (TO CONFIRM):
  ('Dr. Aimon Aslam',    '{"Dr Aimon Aslam"}', true, null, null),
  ('Dr. Shizah',         '{"Dr Shizah"}', true, null, null),
  ('Dr. Rania',          '{"Dr Rania"}', true, null, null),
  ('Dr. Ali Ahmed',      '{"Dr Ali Ahmed"}', true, null, null),
  ('Dr. Maham Waheed',   '{"Dr Maham Waheed"}', true, null, 'ISB'),
  ('Dr. Aqsa Nadeem',    '{"Dr Aqsa Nadeem"}', true, null, 'ISB'),
  -- Hygienists / assistants who appear on visits:
  ('Hira Anis',          '{"Hira Anis"}', false, null, 'KHI'),
  ('Anousha Khan',       '{"Anousha Khan"}', false, null, 'KHI');

-- ---------------------------------------------------------------------
-- Permissions (rows of the checkbox grid)
-- ---------------------------------------------------------------------
insert into public.permissions (key, label, category, sort_order) values
  ('patients.view',        'View patient profiles',                    'Patients', 10),
  ('patients.create',      'Register new patients (auto Mr#)',          'Patients', 11),
  ('patients.edit',        'Edit patient details',                      'Patients', 12),
  ('sheet.view',           'View Aaj ki List / queue',                  'Daily list', 20),
  ('sheet.edit',           'Add and edit Aaj ki List entries',          'Daily list', 21),
  ('treatment.enter',      'Enter treatment done / braces details',     'Daily list', 22),
  ('braces.manage',        'Manage braces cases (plan, extraction)',    'Braces', 30),
  ('braces.override',      'Override braces protocol rules',            'Braces', 31),
  ('retainers.manage',     'Manage retainer cases',                     'Braces', 32),
  ('doctor_log.view_all',  'See every doctor''s daily log',             'Doctors', 40),
  ('photos.upload',        'Upload clinic photos and X-rays',           'Photos', 50),
  ('photos.view_raw',      'View raw clinic photos folder',             'Photos', 51),
  ('xrays.view',           'View X-rays',                               'Photos', 52),
  ('dues.view',            'See $$ pending dues flag',                  'Billing', 60),
  ('dues.override',        'Override the dues hold',                    'Billing', 61),
  ('billing.view',         'View invoices and payments',                'Billing', 62),
  ('billing.create',       'Create invoices and take payments',         'Billing', 63),
  ('billing.edit',         'Edit or void invoices',                     'Billing', 64),
  ('billing.refund',       'Give refunds',                              'Billing', 65),
  ('discount.give',        'Give discounts within cap',                 'Billing', 66),
  ('discount.approve',     'Approve discounts above cap',               'Billing', 67),
  ('cash.close',           'Daily cash closing',                        'Accounts', 70),
  ('cash.verify',          'Verify cash closing',                       'Accounts', 71),
  ('expenses.manage',      'Add and edit expenses',                     'Accounts', 72),
  ('finance.view',         'View all financial reports',                'Accounts', 73),
  ('branch_revenue.view',  'View own branch revenue',                   'Accounts', 74),
  ('commission.view_own',  'See own doctor percentage',                 'Accounts', 75),
  ('commission.view_all',  'See all doctor percentages',                'Accounts', 76),
  ('commission.manage',    'Set doctor percentage rules',               'Accounts', 77),
  ('lab.manage',           'Lab work entries',                          'Coordinator', 80),
  ('reminders.manage',     'Follow-up reminders and drop-off list',     'Coordinator', 81),
  ('complaints.view',      'Complaints inbox',                          'Coordinator', 82),
  ('flags.raise',          'Flag patient for Dr. Ali',                  'Coordinator', 83),
  ('flags.clear',          'Clear Dr. Ali flag',                        'Coordinator', 84),
  ('schedule.manage',      'Edit Dr. Ali''s calendar',                  'Coordinator', 85),
  ('inventory.manage',     'Inventory',                                 'Operations', 90),
  ('export.data',          'Export / download data',                    'Admin', 100),
  ('settings.manage',      'Treatments, templates and settings',        'Admin', 101),
  ('users.manage',         'Manage users and permissions',              'Admin', 102),
  ('audit.view',           'Audit log',                                 'Admin', 103);

-- Draft defaults (from the blueprint grid). Dr. Ali ticks/unticks in the app.
with grid(key, front_desk, assistant, doctor, coordinator, accountant) as (values
  ('patients.view',        true,  true,  true,  true,  true),
  ('patients.create',      true,  false, false, true,  false),
  ('patients.edit',        true,  false, false, true,  false),
  ('sheet.view',           true,  true,  true,  true,  true),
  ('sheet.edit',           true,  true,  true,  true,  false),
  ('treatment.enter',      false, true,  true,  false, false),
  ('braces.manage',        false, false, true,  false, false),
  ('braces.override',      false, false, false, false, false),
  ('retainers.manage',     false, true,  true,  true,  false),
  ('doctor_log.view_all',  false, false, false, true,  true),
  ('photos.upload',        false, true,  true,  true,  false),
  ('photos.view_raw',      false, true,  true,  true,  false),
  ('xrays.view',           true,  true,  true,  true,  false),
  ('dues.view',            true,  true,  true,  true,  true),
  ('dues.override',        false, false, false, false, true),
  ('billing.view',         true,  false, false, true,  true),
  ('billing.create',       true,  false, false, false, true),
  ('billing.edit',         false, false, false, false, true),
  ('billing.refund',       false, false, false, false, true),
  ('discount.give',        true,  false, false, false, true),
  ('discount.approve',     false, false, false, false, true),
  ('cash.close',           true,  false, false, false, false),
  ('cash.verify',          false, false, false, false, true),
  ('expenses.manage',      false, false, false, false, true),
  ('finance.view',         false, false, false, false, true),
  ('branch_revenue.view',  false, false, false, false, true),
  ('commission.view_own',  false, false, true,  false, false),
  ('commission.view_all',  false, false, false, false, true),
  ('commission.manage',    false, false, false, false, true),
  ('lab.manage',           false, true,  false, true,  false),
  ('reminders.manage',     true,  false, false, true,  false),
  ('complaints.view',      false, false, false, true,  false),
  ('flags.raise',          true,  true,  true,  true,  true),
  ('flags.clear',          false, false, false, false, false),
  ('schedule.manage',      false, false, false, true,  false),
  ('inventory.manage',     false, true,  false, true,  true),
  ('export.data',          false, false, false, false, true),
  ('settings.manage',      false, false, false, false, false),
  ('users.manage',         false, false, false, false, false),
  ('audit.view',           false, false, false, false, false)
)
insert into public.role_permissions (role, permission_key, allowed)
select r.role, g.key,
       case r.role
         when 'front_desk'  then g.front_desk
         when 'assistant'   then g.assistant
         when 'doctor'      then g.doctor
         when 'coordinator' then g.coordinator
         when 'accountant'  then g.accountant
         else true
       end
  from grid g
 cross join (values ('front_desk'::public.staff_role), ('assistant'), ('doctor'),
                    ('coordinator'), ('accountant'), ('admin')) as r(role);

-- Discount caps: placeholders until Dr. Ali sets them (TO CONFIRM).
insert into public.discount_caps (role, max_percent, max_amount) values
  ('front_desk', 10, 5000),
  ('accountant', null, null);

-- ---------------------------------------------------------------------
-- Treatments (Aaj ki List "Treatment" dropdown). Prices left blank.
-- ---------------------------------------------------------------------
insert into public.treatments (name, category, is_braces_monthly, sort_order) values
  ('Monthly',               'braces',     true,  1),
  ('Monthly / Followup',    'braces',     true,  2),
  ('Monthly / Ext',         'braces',     true,  3),
  ('Bonding',               'braces',     false, 4),
  ('Upper Bonding',         'braces',     false, 5),
  ('Lower Bonding',         'braces',     false, 6),
  ('Bracket Fix',           'braces',     false, 7),
  ('Braces Checkup',        'braces',     false, 8),
  ('Braces Scaling',        'braces',     false, 9),
  ('Braces Off',            'braces',     false, 10),
  ('Retainer Impression',   'retainer',   false, 20),
  ('Retainer Pick',         'retainer',   false, 21),
  ('Retainer Followup',     'retainer',   false, 22),
  ('Checkup',               'general',    false, 30),
  ('Followup',              'general',    false, 31),
  ('Scaling',               'general',    false, 32),
  ('Filling',               'general',    false, 33),
  ('RCT',                   'general',    false, 34),
  ('Extraction',            'surgery',    false, 35),
  ('X-Ray / OPG',           'diagnostic', false, 36),
  ('Crown Insertion',       'cosmetic',   false, 40),
  ('Veneers Insertion',     'cosmetic',   false, 41),
  ('Veneers Followup',      'cosmetic',   false, 42),
  ('Smile Makeover',        'cosmetic',   false, 43),
  ('Shape Modification',    'cosmetic',   false, 44),
  ('Hygiene Appointment',   'general',    false, 45),
  ('Implant Check',         'surgery',    false, 46),
  ('Pain / Emergency',      'general',    false, 47);

-- ---------------------------------------------------------------------
-- Braces protocol (Braces Treatment Module). Months 8-18 wires TO CONFIRM.
-- ---------------------------------------------------------------------
insert into public.braces_protocol
  (month, treating_groups, checker_group, planned_wire, photo_required, requires_dr_ali_plan,
   extraction_decision, extraction_deadline, dues_checkpoint, retainer_payment_reminder,
   ends_non_extraction, ends_extraction, instructions, confirmed) values
  (1,  '{1}',   null, 'O12', true,  true,  false, false, false, false, false, false, '{"Click photo","Ask treatment plan from Dr. Ali"}', true),
  (2,  '{3}',   2,    'O12', false, false, false, false, false, false, false, false, '{}', true),
  (3,  '{3}',   2,    'O14', false, false, false, false, false, false, false, false, '{}', true),
  (4,  '{1,2}', 1,    'O16', true,  false, true,  false, false, false, false, false, '{"Click photo","Decide and do extractions"}', true),
  (5,  '{3}',   2,    'O16', false, false, false, false, false, false, false, false, '{}', true),
  (6,  '{3}',   2,    'O16', false, false, false, false, false, false, false, false, '{}', true),
  (7,  '{1,2}', 1,    'O16', true,  false, false, true,  false, false, false, false, '{"Click photo","No extractions beyond this month","Make sure all extractions are done"}', true),
  (8,  '{3}',   2,    null,  false, false, false, false, true,  true,  false, false, '{"Dues should be cleared","Remind retainer payment to patient"}', false),
  (9,  '{3}',   2,    null,  false, false, false, false, false, false, false, false, '{}', false),
  (10, '{1,2}', 1,    null,  true,  false, false, false, false, false, true,  false, '{"Click photo","END non-extraction cases"}', false),
  (11, '{3}',   2,    null,  false, false, false, false, false, false, false, false, '{}', false),
  (12, '{1}',   1,    null,  true,  false, false, false, false, false, true,  false, '{"Click photo","END non-extraction cases"}', false),
  (13, '{1,2}', 1,    null,  true,  false, false, false, false, false, false, false, '{"Click photo"}', false),
  (14, '{3}',   2,    null,  false, false, false, false, false, false, false, false, '{}', false),
  (15, '{1}',   1,    null,  true,  false, false, false, true,  true,  false, false, '{"Click photo","Dues should be cleared","Remind retainer payment to patient"}', false),
  (16, '{3}',   2,    null,  false, false, false, false, false, false, false, false, '{}', false),
  (17, '{3}',   2,    null,  false, false, false, false, false, false, false, false, '{}', false),
  (18, '{1,2}', 1,    null,  true,  false, false, false, false, false, false, true,  '{"Click photo","END extraction cases"}', false);

-- ---------------------------------------------------------------------
-- Invoice templates (Dr. Ali picks the default)
-- ---------------------------------------------------------------------
insert into public.invoice_templates (key, name, is_default, config) values
  ('classic',  'Classic (purple header, itemised)',       true,  '{"accent":"#4B2A7B","layout":"classic"}'),
  ('minimal',  'Minimal (black and white, print-friendly)', false, '{"accent":"#111111","layout":"minimal"}'),
  ('premium',  'Premium (gold accent, logo centred)',      false, '{"accent":"#B08D57","layout":"premium"}'),
  ('thermal',  'Thermal receipt (80mm printer)',           false, '{"layout":"thermal","width_mm":80}');

-- ---------------------------------------------------------------------
-- Expense categories: starter list until the Healthwire list is exported (TO CONFIRM)
-- ---------------------------------------------------------------------
insert into public.expense_categories (name, sort_order) values
  ('Rent', 1), ('Salaries', 2), ('Doctor percentage', 3), ('Dental supplies', 4),
  ('Lab charges', 5), ('Utilities (electricity, gas, water)', 6), ('Internet and phone', 7),
  ('Maintenance and repairs', 8), ('Marketing and ads', 9), ('Taxes', 10),
  ('Travel', 11), ('Staff food and refreshments', 12), ('Cleaning and housekeeping', 13),
  ('Equipment', 14), ('Software and subscriptions', 15), ('Miscellaneous', 99);

-- ---------------------------------------------------------------------
-- Inventory starter items
-- ---------------------------------------------------------------------
insert into public.inventory_items (name, category, unit) values
  ('Brackets kit', 'brackets', 'kit'), ('Lingual buttons', 'brackets', 'pcs'),
  ('NiTi wire 012', 'wires', 'pcs'), ('NiTi wire 014', 'wires', 'pcs'),
  ('NiTi wire 016', 'wires', 'pcs'), ('Wire 018', 'wires', 'pcs'),
  ('Open coil spring', 'wires', 'pcs'), ('Ligature wire', 'wires', 'pcs'),
  ('Power chain', 'elastics', 'roll'), ('O-rings', 'elastics', 'pack'),
  ('Elastics', 'elastics', 'pack'), ('Bonding adhesive', 'bonding', 'pcs'),
  ('Etchant', 'bonding', 'pcs'), ('Retainer sheets', 'retainers', 'pcs'),
  ('Impression material', 'consumables', 'pack'), ('Gloves', 'consumables', 'box'),
  ('Masks', 'consumables', 'box');
