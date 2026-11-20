-- aoALB 2 スキーマ草案（設計レビュー用）
-- これはmigrationではない。どの環境にも適用しないこと。
-- 第4段階で、新しい開発用Supabaseプロジェクト向けに migration / rollback / verification の3点として作り直す。
do $guard$ begin
  raise exception 'aoALB 2 schema draft: do not apply.';
end $guard$;

create schema if not exists private;

-- 利用者 -----------------------------------------------------------------
create type public.account_status as enum ('invited', 'active', 'disabled');
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (char_length(display_name) between 1 and 60),
  status public.account_status not null default 'invited',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table public.system_admins (
  user_id uuid primary key references public.profiles(user_id),
  active boolean not null default true
);

-- 工事 -------------------------------------------------------------------
create type public.member_role as enum ('admin', 'member', 'viewer');
create table public.projects (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 160),
  kouji_code text,
  contractor text not null default '',
  status text not null default 'active' check (status in ('active', 'closed', 'trashed')),
  revision bigint not null default 1,
  created_by uuid references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.project_members (
  project_id uuid not null references public.projects(id),
  user_id uuid not null references public.profiles(user_id),
  role public.member_role not null default 'member',
  active boolean not null default true,
  primary key (project_id, user_id)
);
create index project_members_user_idx on public.project_members(user_id) where active;

-- 所属工事IDを1文につき1回だけ計算する（ポリシーでは (select ...) で包む）
create function private.my_project_ids(p_min public.member_role default 'viewer')
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.project_id), '{}')
  from public.project_members m
  join public.projects p on p.id = m.project_id and p.status <> 'trashed'
  join public.profiles u on u.user_id = m.user_id and u.status = 'active' and u.deleted_at is null
  where m.user_id = (select auth.uid()) and m.active
    and case p_min when 'viewer' then true
                   when 'member' then m.role in ('admin', 'member')
                   else m.role = 'admin' end;
$$;

-- 写真 -------------------------------------------------------------------
create table public.import_batches (
  id uuid primary key,
  project_id uuid not null references public.projects(id),
  source_kind text not null check (source_kind in ('files', 'folder', 'zip', 'aopic_zip', 'migration')),
  total int not null default 0, accepted int not null default 0,
  rejected int not null default 0, duplicates int not null default 0,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now()
);
create index import_batches_project_idx on public.import_batches(project_id, created_at desc);

create table public.photos (
  id uuid primary key,                       -- 端末でUUIDv7を採番（冪等）
  project_id uuid not null references public.projects(id),
  import_batch_id uuid references public.import_batches(id),
  source text not null check (source in ('aopic', 'camera', 'file', 'zip', 'migrated')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null default 'image/jpeg' check (mime_type = 'image/jpeg'),
  width int not null check (width > 0), height int not null check (height > 0),
  bytes bigint not null check (bytes > 0),
  original_path text not null, thumb_path text not null, print_path text,
  taken_at timestamptz,
  taken_at_source text not null check (taken_at_source in ('exif', 'file', 'aopic', 'manual', 'unknown')),
  original_filename text, folder_label text,
  aopic jsonb,                               -- photoUid・boardSnapshot・分類原本（作成後は不変）
  upload_state text not null default 'registered' check (upload_state in ('registered', 'uploaded', 'ready')),
  status text not null default 'active' check (status in ('active', 'trashed')),
  trashed_at timestamptz, trashed_by uuid,
  revision bigint not null default 1,
  created_by uuid not null references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index photos_project_taken_idx on public.photos(project_id, taken_at, id) where status = 'active';
create index photos_project_sha_idx on public.photos(project_id, sha256);
create index photos_project_updated_idx on public.photos(project_id, updated_at);
create unique index photos_aopic_uid_idx on public.photos(project_id, ((aopic->>'photoUid'))) where aopic ? 'photoUid';

create table public.photo_classifications (
  photo_id uuid primary key references public.photos(id),
  project_id uuid not null references public.projects(id),
  koushu text not null default '', shubetsu text not null default '', saibetsu text not null default '',
  sokuten text not null default '', tekiyo text not null default '',
  source text not null check (source in ('aopic', 'manual', 'preset', 'migrated', 'none')),
  revision bigint not null default 1,
  updated_by uuid references public.profiles(user_id),
  updated_at timestamptz not null default now()
);
create index photo_classifications_project_idx on public.photo_classifications(project_id, koushu, shubetsu, saibetsu);

create table public.classification_presets (
  id uuid primary key, project_id uuid not null references public.projects(id),
  name text not null, values jsonb not null, revision bigint not null default 1
);
create table public.classification_terms (
  project_id uuid not null references public.projects(id),
  field text not null check (field in ('koushu', 'shubetsu', 'saibetsu', 'sokuten', 'tekiyo')),
  value text not null, use_count int not null default 1, last_used_at timestamptz not null default now(),
  primary key (project_id, field, value)
);

-- 台帳 -------------------------------------------------------------------
create table public.ledgers (
  id uuid primary key,
  project_id uuid not null references public.projects(id),
  title text not null, template text not null default 'construction-3',
  cover jsonb not null default '{}', view_mode text not null default 'single' check (view_mode in ('single', 'spread')),
  status text not null default 'active' check (status in ('active', 'trashed')),
  revision bigint not null default 1,
  updated_by uuid, updated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index ledgers_project_idx on public.ledgers(project_id, updated_at desc);

create table public.ledger_pages (
  id uuid primary key,
  ledger_id uuid not null references public.ledgers(id),
  project_id uuid not null,
  sort_key text not null collate "C",       -- 分数インデックス
  status text not null default 'active' check (status in ('active', 'deleted')),
  revision bigint not null default 1
);
create index ledger_pages_ledger_idx on public.ledger_pages(ledger_id, sort_key) where status = 'active';

create table public.ledger_slots (
  id uuid primary key,
  page_id uuid not null references public.ledger_pages(id),
  ledger_id uuid not null references public.ledgers(id),
  project_id uuid not null,
  slot_index smallint not null check (slot_index between 0 and 2),
  kind text not null check (kind in ('empty', 'photo', 'blank')),
  photo_id uuid references public.photos(id),
  revision bigint not null default 1,
  unique (page_id, slot_index),
  check ((kind = 'photo') = (photo_id is not null))
);
-- 台帳内の重複写真を索引1回で防ぐ（現行のO(枠数²)チェックを置換）
create unique index ledger_slots_photo_once_idx on public.ledger_slots(ledger_id, photo_id) where photo_id is not null;
create index ledger_slots_photo_idx on public.ledger_slots(photo_id) where photo_id is not null;

create table public.ledger_captions (
  ledger_id uuid not null references public.ledgers(id),
  photo_id uuid not null references public.photos(id),
  project_id uuid not null,
  caption jsonb not null default '{}',
  revision bigint not null default 1,
  primary key (ledger_id, photo_id)
);

-- 同期・冪等・監査 -------------------------------------------------------
create table public.change_log (
  seq bigint generated always as identity primary key,
  project_id uuid not null,
  entity text not null, entity_id uuid not null, revision bigint not null,
  op text not null, actor uuid, client_op_id uuid,
  at timestamptz not null default now()
);
create index change_log_project_seq_idx on public.change_log(project_id, seq);

create table public.client_ops (
  op_id uuid primary key, project_id uuid not null, user_id uuid not null,
  kind text not null, result jsonb not null, at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  project_id uuid, actor uuid, action text not null, entity text, entity_id uuid,
  summary jsonb not null default '{}' check (octet_length(summary::text) <= 4096),
  at timestamptz not null default now()
);

-- RLS（読取りのみ直接許可。書込みはRPC） --------------------------------
alter table public.photos enable row level security;
create policy photos_select on public.photos for select to authenticated using (
  project_id = any ((select private.my_project_ids('viewer')))
  and (status = 'active' or project_id = any ((select private.my_project_ids('admin'))))
);
-- 他の表も同じ形（project_id = any((select private.my_project_ids(...)))）

-- Storage：パス {project_id}/{o|t|p}/{photo_id}.jpg
-- 写真行は主キー1件照合。ごみ箱の写真はadminのみ（現行の保護を維持）。
create policy aoalb2_photos_read on storage.objects for select to authenticated using (
  bucket_id = 'aoalb2-photos'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and ((storage.foldername(name))[1])::uuid = any ((select private.my_project_ids('viewer')))
  and (
    ((storage.foldername(name))[1])::uuid = any ((select private.my_project_ids('admin')))
    or exists (
      select 1 from public.photos p
      where p.id = (substring(name from '([0-9a-f-]{36})\.jpg$'))::uuid
        and p.project_id = ((storage.foldername(name))[1])::uuid
        and p.status = 'active'
    )
  )
);
create policy aoalb2_photos_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'aoalb2-photos'
  and ((storage.foldername(name))[1])::uuid = any ((select private.my_project_ids('member')))
  and name ~ '^[0-9a-f-]{36}/(o|t|p)/[0-9a-f-]{36}\.jpg$'
);
-- update / delete ポリシーは作らない（上書き・削除不可。削除はEdge Function）

-- 主要RPC（署名のみ） ----------------------------------------------------
-- register_photos(p_op_id uuid, p_project_id uuid, p_batch_id uuid, p_photos jsonb) returns jsonb
--   → 各写真：created / existing(same op) / duplicate_candidate(sha256一致の既存ID・取込み日)
-- complete_photos(p_op_id uuid, p_photo_ids uuid[]) returns jsonb
--   → storage.objects の存在と容量を確認して upload_state='ready'
-- classify_photos(p_op_id uuid, p_photo_ids uuid[], p_patch jsonb, p_expected jsonb) returns jsonb
-- apply_ledger_ops(p_op_id uuid, p_ledger_id uuid, p_base_revision bigint, p_ops jsonb) returns jsonb
--   → applied ops, rejected ops（対象枠の現在値つき）, new ledger revision, changed slot revisions
-- get_changes(p_project_id uuid, p_since_seq bigint, p_limit int default 500) returns jsonb
-- trash_photos / restore_photos / trash_ledger / restore_ledger / duplicate_ledger
-- いずれも security definer, set search_path = '', client_ops で冪等, change_log へ1行, 同じ工事内だけを操作
