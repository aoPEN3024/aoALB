begin;

alter table public.photos
  drop constraint if exists photos_site_sha256_unique;

drop policy if exists site_photos_jpeg_update on storage.objects;

update storage.buckets
set file_size_limit = null,
    allowed_mime_types = null
where id = 'site-photos';
drop policy if exists site_photos_jpeg_insert on storage.objects;
drop policy if exists site_photos_complete_select on storage.objects;

alter table public.photo_objects
  drop constraint if exists photo_objects_completion_consistent,
  drop constraint if exists photo_objects_status_allowed,
  drop constraint if exists photo_objects_thumbnail_site_path,
  drop constraint if exists photo_objects_thumbnail_complete,
  drop column if exists thumbnail_height,
  drop column if exists thumbnail_width,
  drop column if exists thumbnail_bytes,
  drop column if exists thumbnail_sha256,
  drop column if exists thumbnail_object_path,
  drop column if exists status;

commit;
