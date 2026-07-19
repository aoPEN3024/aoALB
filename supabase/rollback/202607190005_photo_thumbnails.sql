begin;

alter table public.photo_objects
  drop constraint if exists photo_objects_thumbnail_site_path,
  drop constraint if exists photo_objects_thumbnail_complete,
  drop column if exists thumbnail_height,
  drop column if exists thumbnail_width,
  drop column if exists thumbnail_bytes,
  drop column if exists thumbnail_sha256,
  drop column if exists thumbnail_object_path;

commit;
