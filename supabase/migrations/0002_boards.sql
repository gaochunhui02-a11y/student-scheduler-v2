-- Migration 0002 — Visual Board data model (boards / board_nodes / board_edges)
--
-- Run once in your Supabase project: SQL Editor -> New query -> paste this
-- whole file -> Run. Safe to run on a database that already has schema.sql
-- and migration 0001 applied. This migration only CREATES three brand-new
-- tables — it does not alter, rename, or drop any existing table, column,
-- or policy, so `schedules`, `classes`, `study_subjects`, and
-- `schedule_items` (and the scheduling logic that reads/writes them) are
-- completely unaffected. `create table if not exists` / guarded policy
-- creation make this file safe to re-run.
--
-- The Board is an independent feature: a board has many nodes, a node can
-- have many edges to other nodes in the same board. Nothing here is read by
-- the existing scheduler. The one intentional bridge to existing data is
-- board_nodes.linked_study_subject_id, a nullable, on-delete-set-null
-- foreign key reserved for a later, explicit "Convert node to study task"
-- action — it is not populated or used by anything yet.

-- ---------------------------------------------------------------------------
-- boards — one row per board a user creates
-- ---------------------------------------------------------------------------
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled board',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists boards_user_id_idx on public.boards (user_id);

alter table public.boards enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'boards' and policyname = 'boards: select own') then
    create policy "boards: select own" on public.boards for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'boards' and policyname = 'boards: insert own') then
    create policy "boards: insert own" on public.boards for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'boards' and policyname = 'boards: update own') then
    create policy "boards: update own" on public.boards for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'boards' and policyname = 'boards: delete own') then
    create policy "boards: delete own" on public.boards for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- board_nodes — draggable cards on a board
--
-- user_id is duplicated onto every node (not just derived via board_id) so
-- every RLS policy here can stay a simple, fast `auth.uid() = user_id` check
-- exactly like every other table in this project, with no policy needing a
-- subquery/join into `boards`.
-- ---------------------------------------------------------------------------
create table if not exists public.board_nodes (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  node_type text not null default 'note',
  title text not null default '',
  x_position double precision not null default 0,
  y_position double precision not null default 0,
  color text,
  linked_study_subject_id uuid references public.study_subjects (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'board_nodes_node_type_check') then
    alter table public.board_nodes
      add constraint board_nodes_node_type_check
      check (node_type in ('goal', 'subject', 'task', 'note'));
  end if;
end $$;

create index if not exists board_nodes_board_id_idx on public.board_nodes (board_id);
create index if not exists board_nodes_user_id_idx on public.board_nodes (user_id);
create index if not exists board_nodes_linked_study_subject_id_idx on public.board_nodes (linked_study_subject_id);

alter table public.board_nodes enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'board_nodes' and policyname = 'board_nodes: select own') then
    create policy "board_nodes: select own" on public.board_nodes for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'board_nodes' and policyname = 'board_nodes: insert own') then
    create policy "board_nodes: insert own" on public.board_nodes for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'board_nodes' and policyname = 'board_nodes: update own') then
    create policy "board_nodes: update own" on public.board_nodes for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'board_nodes' and policyname = 'board_nodes: delete own') then
    create policy "board_nodes: delete own" on public.board_nodes for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- board_edges — a connection between two nodes on the same board
-- (also used to represent parent/child: relationship = 'parent' means
-- source_node_id is the parent of target_node_id)
-- ---------------------------------------------------------------------------
create table if not exists public.board_edges (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  source_node_id uuid not null references public.board_nodes (id) on delete cascade,
  target_node_id uuid not null references public.board_nodes (id) on delete cascade,
  relationship text not null default 'related',
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'board_edges_relationship_check') then
    alter table public.board_edges
      add constraint board_edges_relationship_check
      check (relationship in ('parent', 'related'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'board_edges_no_self_edge') then
    alter table public.board_edges
      add constraint board_edges_no_self_edge
      check (source_node_id <> target_node_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'board_edges_unique_pair') then
    alter table public.board_edges
      add constraint board_edges_unique_pair
      unique (board_id, source_node_id, target_node_id);
  end if;
end $$;

create index if not exists board_edges_board_id_idx on public.board_edges (board_id);
create index if not exists board_edges_source_node_id_idx on public.board_edges (source_node_id);
create index if not exists board_edges_target_node_id_idx on public.board_edges (target_node_id);

alter table public.board_edges enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'board_edges' and policyname = 'board_edges: select own') then
    create policy "board_edges: select own" on public.board_edges for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'board_edges' and policyname = 'board_edges: insert own') then
    create policy "board_edges: insert own" on public.board_edges for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'board_edges' and policyname = 'board_edges: update own') then
    create policy "board_edges: update own" on public.board_edges for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'board_edges' and policyname = 'board_edges: delete own') then
    create policy "board_edges: delete own" on public.board_edges for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Cascade behavior summary (all enforced at the database level via FKs above):
--   delete a board  -> deletes its board_nodes AND its board_edges
--   delete a node   -> deletes any board_edges where it is the source OR target
--   delete a study_subjects row -> board_nodes.linked_study_subject_id is set
--                                  null on the node, the node itself is kept
-- ---------------------------------------------------------------------------
