-- DESTRUCTIVE: removes only the site creation code feature and its attempt history.
-- Do not run unless rollback has been explicitly approved.
-- Existing sites, members, photos, ledgers, Storage objects and audit logs are not removed.

begin;

drop function if exists public.create_site(text, text, text, text, text);
drop table if exists private.site_creation_attempts;
drop table if exists private.site_creation_codes;

commit;
