-- Run in Supabase SQL Editor only after confirming the target project.
-- This generates a new random company-wide site creation code on the server.
-- The plaintext is shown once in the result and is never written to a table.
-- Running this immediately invalidates the previous code.

begin;

do $preflight$
begin
  if pg_catalog.to_regclass('private.site_creation_codes') is null
     or pg_catalog.to_regprocedure('extensions.crypt(text,text)') is null then
    raise exception 'Apply 202607220001_site_creation_code.sql first.';
  end if;
end
$preflight$;

create temp table new_site_creation_code (
  plaintext text not null,
  version integer not null
) on commit preserve rows;

do $rotate$
declare
  v_plaintext text := 'A' || 'a' || '7' ||
    translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/=', 'XYZ');
  v_version integer;
begin
  insert into private.site_creation_codes(singleton, code_hash, version, changed_at)
  values (
    true,
    extensions.crypt(v_plaintext, extensions.gen_salt('bf', 10)),
    1,
    now()
  )
  on conflict (singleton) do update set
    code_hash = excluded.code_hash,
    version = private.site_creation_codes.version + 1,
    changed_at = now()
  returning version into v_version;

  insert into pg_temp.new_site_creation_code(plaintext, version)
  values (v_plaintext, v_version);
end
$rotate$;

commit;

select plaintext as site_creation_code, version,
  'この結果に一度だけ表示します。安全な場所へ控え、チャット・Git・アプリ設定へ保存しないでください。' as note
from pg_temp.new_site_creation_code;

drop table pg_temp.new_site_creation_code;
