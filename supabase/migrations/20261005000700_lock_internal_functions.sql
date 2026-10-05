-- Trigger functions run automatically on table changes; nobody needs to call them directly.
-- Remaining callable functions are deliberate: access-rule helpers that only answer about the
-- caller, and app actions (braces guidance, cash closing, discounts) that check permission inside.
do $$
declare f text;
begin
  foreach f in array array[
    'assign_mr_number()', 'audit_row()', 'cash_closing_verify_only()', 'complaint_stamp()',
    'expense_stamp()', 'flag_stamp()', 'guard_admin_checker()', 'guard_own_overrides()',
    'guard_patient_portal_link()', 'guard_staff_delete()', 'guard_staff_row()',
    'invoice_after_write()', 'invoice_before_write()', 'invoice_guard_approval()',
    'payment_stamp()', 'photo_marks_visit()', 'protect_mr_number()', 'rating_stamp()',
    'recalc_invoice_subtotal()', 'visit_before_write()', 'visit_staff_check()', 'touch_updated_at()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

revoke execute on function public.setting(text) from authenticated;
