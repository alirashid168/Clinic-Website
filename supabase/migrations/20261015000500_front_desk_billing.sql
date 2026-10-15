-- =============================================================================
-- Front desk makes invoices and takes payments.
--
-- The owner (Dr. Ali, 15 Oct 2026, at the North Nazimabad front desk with a patient ready to start treatment and pay): "there is
-- no option to add invoice of a patient ... payment could be taken and an invoice bill printout provided for the patient."
--
-- 1. role_permissions: front_desk gets billing.create ("Create invoices and take payments"), on purpose (the owner asked).
-- 2. Reading back what they bill: until now invoices, their lines and payments could be read only with billing.view (accounts and
--    Dr. Ali). save_invoice runs as the caller, and the payment form, the patient's Money panel and the printed bill read the
--    patient's invoices and payments, so someone with billing.create alone could save an invoice but not see it. These policies
--    let billing.create read invoices, invoice lines and payments of the branches they may use.
--    Totals stay away from front desk: every total on the website (Received today, branch revenue, reports, accounts) is shown
--    only with billing.view or finance.view, which front desk does not have. (The money-privacy update, 20261015000400, narrows
--    the database side further.)
--
-- Additive and safe to run more than once.
-- HOW TO APPLY: Supabase dashboard -> SQL Editor -> paste this whole file -> Run.
-- =============================================================================

insert into public.role_permissions (role, permission_key, allowed)
values ('front_desk', 'billing.create', true)
on conflict (role, permission_key) do update set allowed = true;

drop policy if exists "billers view invoices" on public.invoices;
create policy "billers view invoices" on public.invoices for select
  using (public.has_perm('billing.create') and public.can_access_branch(branch_id));

drop policy if exists "billers view invoice items" on public.invoice_items;
create policy "billers view invoice items" on public.invoice_items for select
  using (exists (select 1 from public.invoices i
                  where i.id = invoice_items.invoice_id
                    and public.has_perm('billing.create') and public.can_access_branch(i.branch_id)));

drop policy if exists "billers view payments" on public.payments;
create policy "billers view payments" on public.payments for select
  using (public.has_perm('billing.create') and public.can_access_branch(branch_id));
