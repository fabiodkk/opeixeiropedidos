-- Cópia pública somente do painel web. Credenciais administrativas e tokens
-- permanecem exclusivamente nas variáveis das Edge Functions.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('opeixeiro-public-panel', 'opeixeiro-public-panel', true, 2097152, array['text/html'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['text/html'];
