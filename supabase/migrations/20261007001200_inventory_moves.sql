-- Stock follows the moves: every inventory move (received +, used −,
-- adjustment ±) updates the branch's stock row, so the quantity on screen is
-- always the sum of what was recorded.
create or replace function public.apply_inventory_move()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.inventory_stock (branch_id, item_id, quantity, updated_at)
  values (new.branch_id, new.item_id, new.change, now())
  on conflict (branch_id, item_id) do update
    set quantity = public.inventory_stock.quantity + excluded.quantity, updated_at = now();
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end $$;

create trigger inventory_move_applies
  before insert on public.inventory_moves
  for each row execute function public.apply_inventory_move();

revoke execute on function public.apply_inventory_move() from public, anon, authenticated;
