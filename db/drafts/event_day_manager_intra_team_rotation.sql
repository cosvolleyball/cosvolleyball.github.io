-- Ordinary within-team changes to the active lineup during a game.
-- Typical cases: 7-person roster playing 6v6 (middle/libero share time);
-- 5-person roster playing 4v4; other extra-roster combinations.
-- A player who actually enters a game is a REGULAR participant, not a sub.

create function public.tm_public_rotate_teammate(
  p_game_id uuid,p_out_player_id uuid,p_in_player_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_rotation uuid;
  v_out_team uuid;
  v_format smallint;
  v_in_attendance text;
  v_game public.tm_games%rowtype;
begin
  select s.id,r.id,r.playing_format
  into v_session,v_rotation,v_format
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and g.status='playing'
    and r.status='published' and s.status='active'
  for update of s;
  if v_session is null then
    raise exception 'Within-team rotation requires a live game'
      using errcode='22023';
  end if;
  if p_out_player_id is null or p_in_player_id is null
     or p_out_player_id=p_in_player_id then
    raise exception 'Choose two different teammates'
      using errcode='22023';
  end if;
  select g.* into v_game from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  where g.id=p_game_id and g.status='playing' and r.status='published';
  if not found then
    raise exception 'Within-team rotation requires a live game'
      using errcode='22023';
  end if;
  select a.team_id into v_out_team from public.tm_game_appearances a
    where a.game_id=p_game_id and a.session_player_id=p_out_player_id
      and a.active_on_court and not a.is_substitute;
  if v_out_team is null then
    raise exception 'Outgoing player must be a regular on-court teammate'
      using errcode='22023';
  end if;
  select sp.attendance into v_in_attendance
    from public.tm_memberships m
    join public.tm_session_players sp on sp.id=m.session_player_id
    where m.rotation_id=v_rotation and m.team_id=v_out_team
      and m.session_player_id=p_in_player_id;
  if v_in_attendance not in ('present','waiting') or v_in_attendance is null then
    raise exception 'Incoming player must be available on the same team'
      using errcode='22023';
  end if;
  if exists (
    select 1 from public.tm_game_appearances a
      join public.tm_games g on g.id=a.game_id
    where a.session_player_id=p_in_player_id
      and a.active_on_court and g.status='playing'
  ) then
    raise exception 'Incoming player is already playing'
      using errcode='22023';
  end if;
  -- Prevent a regular mid-game switch on a team that already lost players:
  -- this operation is a 1-for-1 player rotation, not a lineup creation.
  if (select count(*) from public.tm_game_appearances
      where game_id=p_game_id and team_id=v_out_team
        and active_on_court)=0 then
    raise exception 'No active player to rotate' using errcode='22023';
  end if;

  update public.tm_game_appearances
    set active_on_court=false
    where game_id=p_game_id and session_player_id=p_out_player_id
      and active_on_court and not is_substitute;
  if not found then
    raise exception 'Outgoing player no longer active'
      using errcode='22023';
  end if;
  insert into public.tm_game_appearances
    (game_id,rotation_id,session_id,session_player_id,team_id,
      is_substitute,active_on_court)
  values (p_game_id,v_rotation,v_session,p_in_player_id,v_out_team,
      false,true)
  on conflict (game_id,session_player_id) do update
    set active_on_court=true;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,details)
    values(v_session,'rotate_teammate',jsonb_build_object(
      'game_id',p_game_id,'out_player_id',p_out_player_id,
      'in_player_id',p_in_player_id,'team_id',v_out_team));
end $$;

revoke execute on function public.tm_public_rotate_teammate(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_public_rotate_teammate(uuid,uuid,uuid)
  to anon,authenticated;
