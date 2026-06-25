insert into storage.buckets (id, name, public, file_size_limit)
values ('ielts-writing-files', 'ielts-writing-files', true, 20971520)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "Anyone can upload IELTS writing files" on storage.objects;
drop policy if exists "Anyone can update IELTS writing files" on storage.objects;
drop policy if exists "Anyone can read IELTS writing files" on storage.objects;
drop policy if exists "Anyone can delete IELTS writing files" on storage.objects;

create policy "Anyone can upload IELTS writing files"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'ielts-writing-files');

create policy "Anyone can update IELTS writing files"
on storage.objects
for update
to anon, authenticated
using (bucket_id = 'ielts-writing-files')
with check (bucket_id = 'ielts-writing-files');

create policy "Anyone can read IELTS writing files"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'ielts-writing-files');

create policy "Anyone can delete IELTS writing files"
on storage.objects
for delete
to anon, authenticated
using (bucket_id = 'ielts-writing-files');
