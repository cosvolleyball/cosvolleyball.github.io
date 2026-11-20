-- Create a 26-player five-team rotation for a two-connection transfer race.
-- Disposable Postgres fixture ONLY.
create table public.tm_test_transfer_keys (
  rotation_id uuid not null,
  session_id uuid not null,
  session_player_id uuid not null,
  team_a_id uuid not null,
  team_b_id uuid not null
);
do $setup_transfer$
declare
  v_session uuid;
  v_old_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_teams jsonb:='[]'::jsonb;
  v_members jsonb;
  v_i int;
  v_size int;
begin
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);
  select session_id into v_old_session
    from public.tm_test_concurrency_keys limit 1;
  perform public.tm_org_end_session(v_old_session);
  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    5::smallint,true,false,false);
  for v_i in 1..26 loop
    perform public.tm_org_add_walkin(
      v_session,'Transfer race player '||v_i,
      'transfer-race-'||v_i||'@example.com');
  end loop;
  for v_i in 1..5 loop
    v_size:=case when v_i=1 then 6 else 5 end;
    select jsonb_agg(id order by id) into v_members from (
      select id from public.tm_session_players
      where session_id=v_session order by id
      limit v_size
      offset case when v_i=1 then 0 else 6+(v_i-2)*5 end
    ) x;
    v_teams:=v_teams||jsonb_build_array(jsonb_build_object(
      'seed',v_i,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions
    where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_teams);
  select revision into v_revision from public.tm_sessions
    where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);
  insert into public.tm_test_transfer_keys(
    rotation_id,session_id,session_player_id,team_a_id,team_b_id)
  select v_rotation,v_session,m.session_player_id,
    (select id from public.tm_teams
      where rotation_id=v_rotation and seed=2),
    (select id from public.tm_teams
      where rotation_id=v_rotation and seed=3)
  from public.tm_memberships m
  join public.tm_teams t on t.id=m.team_id
  where m.rotation_id=v_rotation and t.seed=1
  order by m.session_player_id limit 1;
end $setup_transfer$;
