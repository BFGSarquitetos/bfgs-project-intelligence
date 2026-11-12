-- BFGS Project Intelligence: migration 001
-- Additive migration: preserves the existing organizations/profiles/projects schema.
create extension if not exists pgcrypto;

create table if not exists public.bfgs_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null,
  client text not null default '',
  phase text not null default 'Anteprojeto',
  status text not null default 'Em andamento',
  owner uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bfgs_projects_owner_created_idx on public.bfgs_projects(owner, created_at desc);

create table if not exists public.bfgs_files (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  size bigint not null default 0,
  mime_type text not null default 'application/octet-stream',
  storage_path text not null unique,
  scope text not null check (scope in ('project','library')),
  project_id uuid references public.bfgs_projects(id) on delete cascade,
  kind text not null default 'Arquivo',
  owner uuid not null references auth.users(id) on delete cascade,
  sha256 text,
  created_at timestamptz not null default now(),
  constraint bfgs_files_scope_project_check check ((scope='project' and project_id is not null) or (scope='library' and project_id is null))
);
create index if not exists bfgs_files_owner_created_idx on public.bfgs_files(owner, created_at desc);
create index if not exists bfgs_files_project_idx on public.bfgs_files(project_id);

alter table public.bfgs_projects enable row level security;
alter table public.bfgs_files enable row level security;
drop policy if exists bfgs_projects_owner_all on public.bfgs_projects;
create policy bfgs_projects_owner_all on public.bfgs_projects for all to authenticated using (owner=auth.uid()) with check (owner=auth.uid());
drop policy if exists bfgs_files_owner_all on public.bfgs_files;
create policy bfgs_files_owner_all on public.bfgs_files for all to authenticated using (owner=auth.uid()) with check (owner=auth.uid());

insert into storage.buckets(id,name,public,file_size_limit)
values ('bfgs-project-files','bfgs-project-files',false,536870912)
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit;

drop policy if exists bfgs_storage_owner_select on storage.objects;
create policy bfgs_storage_owner_select on storage.objects for select to authenticated
using (bucket_id='bfgs-project-files' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists bfgs_storage_owner_insert on storage.objects;
create policy bfgs_storage_owner_insert on storage.objects for insert to authenticated
with check (bucket_id='bfgs-project-files' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists bfgs_storage_owner_update on storage.objects;
create policy bfgs_storage_owner_update on storage.objects for update to authenticated
using (bucket_id='bfgs-project-files' and (storage.foldername(name))[1]=auth.uid()::text)
with check (bucket_id='bfgs-project-files' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists bfgs_storage_owner_delete on storage.objects;
create policy bfgs_storage_owner_delete on storage.objects for delete to authenticated
using (bucket_id='bfgs-project-files' and (storage.foldername(name))[1]=auth.uid()::text);
