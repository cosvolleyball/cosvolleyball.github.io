-- Disposable fixture. Exercise the organizer's normal save path for each choice.
begin;
alter table public.tm_profiles disable trigger tm_check_profile_choices;
insert into public.tm_profiles(email,display_name,gender,positions)
  values ('legacy@example.invalid','Legacy','Older label',array['Utility']);
alter table public.tm_profiles enable trigger tm_check_profile_choices;
do $$
declare
  email constant text := 'profile@example.invalid';
  role text;
  roles text[];
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  foreach role in array array['outside','setter','middle','libero','right side','flex'] loop
    perform public.tm_org_save_profile(email,'Player',1::smallint,'male',array[role]);
  end loop;
  perform public.tm_org_save_profile(email,'Player',10::smallint,'female',array['outside','right side']);
  perform public.tm_org_save_profile(email,'Player',10::smallint,'Female',array['Setter','Outside']);
  perform public.tm_org_save_profile(email,'Player',null,null,'{}');
  foreach roles slice 1 in array array[['Flex','middle'],['Outside','outside'],['setter','unlisted']] loop
    begin
      perform public.tm_org_save_profile(email,'Player',null,'female',roles);
      raise exception 'Invalid positions accepted: %',roles;
    exception when sqlstate '22023' then null;
    end;
  end loop;
  begin
    perform public.tm_org_save_profile(email,'Player',null,'other','{}');
    raise exception 'Invalid gender accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.tm_org_save_profile(email,'Player',null,null,array['outside','setter','middle']);
    raise exception 'Three positions accepted';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_org_save_profile('legacy@example.invalid','Legacy',4::smallint,'Older label',array['Utility']);
  perform public.tm_org_save_profile('legacy@example.invalid','Legacy',4::smallint,'male',array['Utility']);
  perform public.tm_org_save_profile('legacy@example.invalid','Legacy',4::smallint,'male',array['flex']);
end $$;
rollback;
