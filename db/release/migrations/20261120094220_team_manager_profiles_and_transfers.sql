-- Supported choices apply to new profile edits. Older entries can be kept
-- while updating a different field on the same player.
set local lock_timeout = '5s';

create function tm_internal.validate_profile_choices()
returns trigger language plpgsql set search_path = ''
as $$
declare
  roles text[];
begin
  if tg_op = 'INSERT' or new.gender is distinct from old.gender then
    if new.gender is not null and lower(btrim(new.gender)) not in ('male','female') then
      raise exception 'Choose Male or Female' using errcode = '22023';
    end if;
  end if;
  if tg_op = 'INSERT' or new.positions is distinct from old.positions then
    roles := array(select lower(btrim(pos)) from unnest(new.positions) pos);
    if not (roles <@ array['outside','setter','middle','libero','right side','flex'])
       or cardinality(roles) <> (select count(distinct pos) from unnest(roles) pos)
       or ('flex' = any(roles) and cardinality(roles) <> 1) then
      raise exception 'Choose up to two different positions or Flex on its own' using errcode = '22023';
    end if;
  end if;
  return null;
end $$;
revoke execute on function tm_internal.validate_profile_choices() from public, anon, authenticated;

-- AFTER distinguishes an insert from the update branch of a profile upsert.
create trigger tm_check_profile_choices after insert or update of gender,positions
on public.tm_profiles for each row execute function tm_internal.validate_profile_choices();

-- Return only IDs that already appear in the public rotation. Attendance,
-- private profiles and transfer history stay behind the projection.
create function public.tm_public_transfer_options(p_rotation_id uuid)
returns table(player_id uuid, target_team_id uuid)
language sql stable security definer set search_path = ''
as $$
  with rotation as (
    select r.id, r.playing_format
    from public.tm_rotations r
    join public.tm_sessions s on s.id = r.session_id
    where r.id = p_rotation_id and r.status = 'published' and s.status = 'active'
      and (select count(*) from public.tm_teams t where t.rotation_id = r.id) = 5
  ), available as (
    select m.session_player_id, m.team_id
    from public.tm_memberships m
    join rotation r on r.id = m.rotation_id
    join public.tm_session_players p on p.id = m.session_player_id
    where p.attendance in ('present','waiting')
  ), idle_teams as (
    select t.id, count(a.session_player_id) - r.playing_format as spare
    from rotation r join public.tm_teams t on t.rotation_id = r.id
    left join available a on a.team_id = t.id
    where not exists (
      select 1 from public.tm_games g where g.rotation_id = r.id
        and g.status = 'playing' and t.id in (g.team_a_id, g.team_b_id)
    )
    group by t.id, r.playing_format
  )
  select a.session_player_id, target.id
  from available a
  join idle_teams donor on donor.id = a.team_id and donor.spare > 0
  cross join idle_teams target
  where target.spare < 0
    and not exists (select 1 from public.tm_transfers h
      where h.rotation_id = p_rotation_id and h.session_player_id = a.session_player_id)
    and not exists (select 1 from public.tm_game_appearances ap
      join public.tm_games g on g.id = ap.game_id
      where g.status = 'playing' and ap.session_player_id = a.session_player_id)
  order by a.session_player_id, target.id;
$$;
revoke execute on function public.tm_public_transfer_options(uuid) from public, anon, authenticated;
grant execute on function public.tm_public_transfer_options(uuid) to anon, authenticated;

create or replace function public.tm_public_transfer(
  p_rotation_id uuid, p_session_player_id uuid, p_to_team_id uuid
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_session_id uuid;
  v_from_team_id uuid;
begin
  -- Recheck eligibility after taking the same session lock as attendance
  -- and game actions. Two simultaneous transfers cannot fill one vacancy twice.
  select s.id into v_session_id from public.tm_rotations r
  join public.tm_sessions s on s.id = r.session_id
  where r.id = p_rotation_id and r.status = 'published' and s.status = 'active'
  for update of s;
  if not found or not exists (select 1 from public.tm_rotations
    where id = p_rotation_id and status = 'published') then
    raise exception 'Transfer is outside an active published rotation' using errcode = '22023';
  end if;
  if exists (select 1 from public.tm_transfers where rotation_id = p_rotation_id
      and session_player_id = p_session_player_id) then
    raise exception 'Player already transferred in this rotation' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tm_public_transfer_options(p_rotation_id)
      where player_id = p_session_player_id and target_team_id = p_to_team_id) then
    raise exception 'A transfer needs a short team and an available extra player, with both teams between games'
      using errcode = '22023';
  end if;

  select team_id into strict v_from_team_id from public.tm_memberships
    where rotation_id = p_rotation_id and session_player_id = p_session_player_id;
  update public.tm_memberships set team_id = p_to_team_id
    where rotation_id = p_rotation_id and session_player_id = p_session_player_id;
  insert into public.tm_transfers(rotation_id,session_id,session_player_id,from_team_id,to_team_id,recorded_by)
    values (p_rotation_id,v_session_id,p_session_player_id,v_from_team_id,p_to_team_id,auth.uid());
  update public.tm_sessions set revision = revision + 1 where id = v_session_id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (v_session_id,'transfer',auth.uid(),jsonb_build_object('rotation_id',p_rotation_id,
      'player_id',p_session_player_id,'from_team_id',v_from_team_id,'to_team_id',p_to_team_id));
end $$;

notify pgrst, 'reload schema';
