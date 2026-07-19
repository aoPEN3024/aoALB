begin;

alter table public.photos
  add constraint photos_site_sha256_unique unique (site_id, sha256);

alter table public.photo_objects
  add column status text not null default 'pending',
  add column thumbnail_object_path text,
  add column thumbnail_sha256 text,
  add column thumbnail_bytes bigint,
  add column thumbnail_width integer,
  add column thumbnail_height integer;

alter table public.photo_objects
  add constraint photo_objects_status_allowed check (status in ('pending', 'complete')),
  add constraint photo_objects_completion_consistent check (
    status = 'pending'
    or (
      status = 'complete'
      and upload_completed_at is not null
      and thumbnail_object_path is not null
      and thumbnail_sha256 is not null
      and thumbnail_bytes is not null
      and thumbnail_width is not null
      and thumbnail_height is not null
    )
  ),
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

update storage.buckets
set file_size_limit = 20971520,
    allowed_mime_types = array['image/jpeg']::text[]
where id = 'site-photos';

create policy site_photos_complete_select on storage.objects
  as restrictive for select to authenticated
  using (
    bucket_id <> 'site-photos'
    or owner_id = auth.uid()::text
    or private.has_site_role_text((storage.foldername(name))[1], 'admin')
    or exists (
      select 1
      from public.photo_objects po
      where po.site_id::text = (storage.foldername(name))[1]
        and po.status = 'complete'
        and po.upload_completed_at is not null
        and po.thumbnail_object_path is not null
        and (po.object_path = name or po.thumbnail_object_path = name)
    )
  );

create policy site_photos_jpeg_insert on storage.objects
  as restrictive for insert to authenticated
  with check (
    bucket_id <> 'site-photos'
    or (
      name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(photos|thumbnails)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
    )
  );

create policy site_photos_jpeg_update on storage.objects
  as restrictive for update to authenticated
  using (bucket_id <> 'site-photos' or storage.extension(name) = 'jpg')
  with check (
    bucket_id <> 'site-photos'
    or (
      name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(photos|thumbnails)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
    )
  );

commit;
