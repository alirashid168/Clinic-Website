-- Expense receipts (photo or PDF of the bill) are attached from Accounts → Expenses
-- as receipts/<expense id>.<ext>. Replacing a receipt re-uploads to the same path,
-- which needs an update policy on the bucket as well as the insert one.
create policy "accounts replace receipts" on storage.objects for update
  using (bucket_id = 'receipts' and public.has_perm('expenses.manage'))
  with check (bucket_id = 'receipts' and public.has_perm('expenses.manage'));
