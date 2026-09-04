-- Nome consistente para a relação usada pelos relatórios do Supabase/PostgREST.
alter table public.opeixeiro_internal_purchase_relations
  drop constraint if exists opeixeiro_internal_purchase_relation_supply_origin_unit_id_fkey;
alter table public.opeixeiro_internal_purchase_relations
  drop constraint if exists opeixeiro_internal_purchase_relations_supply_origin_unit_id_fkey;
alter table public.opeixeiro_internal_purchase_relations
  add constraint opeixeiro_internal_purchase_relations_supply_origin_unit_id_fkey
  foreign key (supply_origin_unit_id) references public.opeixeiro_units(id);
notify pgrst, 'reload schema';
