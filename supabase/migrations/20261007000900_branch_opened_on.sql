-- Branch opening date (Admin → Clinic setup). Used to keep expenses from
-- before a branch existed off that branch, and shown nowhere public.
alter table public.branches add column if not exists opened_on date;
-- Islamabad opened in December 2025 (Dr. Ali); the other dates are filled in by him on the Clinic setup page.
update public.branches set opened_on = '2025-12-01' where code = 'ISB' and opened_on is null;
