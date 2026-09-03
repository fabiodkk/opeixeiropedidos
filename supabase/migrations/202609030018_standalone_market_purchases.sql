-- Compra de última hora sem pedido vinculado é uma relação própria: não deve
-- ser mesclada ao pedido diário do destino nem entrar em seus pontos de coleta.
alter table public.opeixeiro_additional_stock_entries
  alter column order_id drop not null;
