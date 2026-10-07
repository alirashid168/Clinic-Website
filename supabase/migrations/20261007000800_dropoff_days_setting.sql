-- The drop-off list used a fixed 42 days even though Admin → Settings has a
-- "Drop-off list after (days)" box. The view now reads that setting (staff can
-- read app_settings; the view runs as the viewer).
create or replace view public.braces_dropoffs
with (security_invoker = true) as
select bc.patient_id, bc.id as braces_case_id, max(v.visit_date) as last_visit,
       current_date - max(v.visit_date) as days_since
  from public.braces_cases bc
  left join public.visits v on v.braces_case_id = bc.id and v.status = 'completed'
 where bc.status = 'active'
 group by bc.patient_id, bc.id
having max(v.visit_date) is null
    or max(v.visit_date) < current_date - coalesce(
         (select nullif(s.value #>> '{}', '')::int from public.app_settings s where s.key = 'dropoff_days'), 42);
