-- EVENT DAY MANAGER PART 6: LATE ARRIVALS / PERMANENT ROSTER REPLACEMENT
-- REVIEW DRAFT ONLY; tested in disposable PostgreSQL, not production.
-- Organizer may fill an unoccupied rotation slot OR replace an unavailable
-- player between games without changing the original registration system.
create function public.tm_org_adjust_roster(
  p_rotation_id uuid,
  p_in_player_id uuid,
  p_team_id uuid,
  p_out_player_id uuid default null
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_in_status text;
  v_out_status text;
  v_total_count integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.* into v_session from public.tm_rotations r
  join public.tm_sessions s on s.id=r.session_id
  where r.id=p_rotation_id and r.status='published'
    and s.status='active'
  for update of s;
  if not found then
    raise exception 'Only an active published rotation can be adjusted'
      using errcode='22023';
  end if;
  if not exists(
    select 1 from public.tm_teams
    where id=p_team_id and rotation_id=p_rotation_id
  ) then
    raise exception 'Team is not in this rotation' using errcode='22023';
  end if;
  if exists(
    select 1 from public.tm_games
    where rotation_id=p_rotation_id and status='playing'
      and p_team_id in (team_a_id,team_b_id)
  ) then
    raise exception 'Cannot change the roster while this team is playing'
      using errcode='22023';
  end if;
  select attendance into v_in_status from public.tm_session_players
    where id=p_in_player_id and session_id=v_session.id;
  if v_in_status is null or v_in_status not in ('present','waiting') then
    raise exception 'Incoming player must be checked in and available'
      using errcode='22023';
  end if;
  if exists (
    select 1 from public.tm_memberships
    where rotation_id=p_rotation_id and session_player_id=p_in_player_id
  ) then
    raise exception 'Incoming player already belongs to a team'
      using errcode='22023';
  end if;
  if p_out_player_id is not null then
    select sp.attendance into v_out_status
    from public.tm_memberships m
    join public.tm_session_players sp on sp.id=m.session_player_id
    where m.rotation_id=p_rotation_id
      and m.team_id=p_team_id and m.session_player_id=p_out_player_id;
    if v_out_status not in ('break','departed') or v_out_status is null then
      raise exception 'Only an unavailable roster member may be replaced'
        using errcode='22023';
    end if;
    delete from public.tm_memberships
    where rotation_id=p_rotation_id and team_id=p_team_id
      and session_player_id=p_out_player_id;
  else
    select count(*) into v_total_count
    from public.tm_memberships
    where rotation_id=p_rotation_id and team_id=p_team_id;
    if v_total_count>=v_session.format then
      raise exception 'Team has no unoccupied roster spot; select an unavailable member'
        using errcode='22023';
    end if;
  end if;
  insert into public.tm_memberships(
    rotation_id,session_id,team_id,session_player_id)
  values (p_rotation_id,v_session.id,p_team_id,p_in_player_id);
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
  values(v_session.id,'adjust_roster',auth.uid(),jsonb_build_object(
    'rotation_id',p_rotation_id,'team_id',p_team_id,
    'in_player_id',p_in_player_id,'out_player_id',p_out_player_id
  ));
end $$;
revoke execute on function public.tm_org_adjust_roster(uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_adjust_roster(uuid,uuid,uuid,uuid)
  to authenticated;
