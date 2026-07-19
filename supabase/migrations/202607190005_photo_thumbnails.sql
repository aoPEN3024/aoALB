begin;

alter table public.photo_objects
  add column thumbnail_object_path text,
  add column thumbnail_sha256 text,
  add column thumbnail_bytes bigint,
  add column thumbnail_width integer,
  add column thumbnail_height integer;

alter table public.photo_objects
  add constraint photo_objects_thumbnail_complete check (
    (thumbnail_object_path is null and thumbnail_sha256 is null and thumbnail_bytes is null and thumbnail_width is null and thumbnail_height is null)
    or
    (thumbnail_object_path is not null and thumbnail_sha256 ~ '^[0-9a-f]{64}$' and thumbnail_bytes > 0 and thumbnail_width > 0 and thumbnail_height > 0)
  ),
  add constraint photo_objects_thumbnail_site_path check (
    thumbnail_object_path is null
    or (
      thumbnail_object_path like site_id::text || '/thumbnails/%'
      and position(E'\\' in thumbnail_object_path) = 0
      and thumbnail_object_path !~ '[[:cntrl:]]'
      and thumbnail_object_path !~ '(^|/)\.\.?(/|$)'
    )
  );

commit;
