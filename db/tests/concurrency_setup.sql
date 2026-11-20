-- Initialize one fresh match solely for two-process concurrency tests.
-- Applied in ephemeral Postgres CI only, never a hosted Supabase database.
create table public.tm_test_concurrency_keys (
  game_id uuid not null,
  session_id uuid not null,
  team_a_id uuid not null,
  team_b_id uuid not null
);
do $setup$
declare
  v_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_teams jsonb := '[]'::jsonb;
  v_members jsonb;
  v_index int;
begin
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);
  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',6::smallint,
    true,false,false);
  for v_index in 1..36 loop
    perform public.tm_org_add_walkin(v_session,
      'Race player '||v_index,'race-'||v_index||'@example.com');
  end loop;
  for v_index in 1..6 loop
    select jsonb_agg(id order by id) into v_members from (
      select id from public.tm_session_players
      where session_id=v_session order by id
      limit 6 offset (v_index-1)*6
    ) t;
    v_teams:=v_teams||jsonb_build_array(
      jsonb_build_object('seed',v_index,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_teams);
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);
  insert into public.tm_test_concurrency_keys
    (game_id,session_id,team_a_id,team_b_id)
  select id,v_session,team_a_id,team_b_id
  from public.tm_games where rotation_id=v_rotation
    and round_number=1 and court=1;
end $setup$;
