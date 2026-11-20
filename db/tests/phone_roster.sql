-- Local browser and phone fixture. The launcher substitutes a synthetic Auth user.
do $fixture$
begin
  if not exists (select 1 from public.events where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    and title='Public local synthetic game') then
    raise exception 'The practice gym requires the local synthetic baseline';
  end if;
insert into public.organizers(user_id) values ('__LOCAL_ORGANIZER_UUID__');
insert into public.registrations(event_id,player_name,player_email,registration_status)
select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Practice Player '||n,
       'practice-'||n||'@example.invalid','registered' from generate_series(1,25) n;
insert into public.registrations(event_id,player_name,player_email,registration_status) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Waiting Player','waiting-phone@example.invalid','waitlisted'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Cancelled Player','cancelled-phone@example.invalid','cancelled');
end $fixture$;
