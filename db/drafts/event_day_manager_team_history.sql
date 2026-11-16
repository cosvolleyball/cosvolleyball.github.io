-- EVENT DAY MANAGER PART 5: ORGANIZER-ONLY TEAMMATE HISTORY
-- Review draft, exercised only on isolated PostgreSQL 17 CI database.
-- Counts *actual completed-game shared appearances*, not assumed rosters.
-- The IDs are session-player IDs. No history carries between sessions.
create function public.tm_org_teammate_pairs(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(
    jsonb_build_array(p.a_id::text,p.b_id::text,p.games)
    order by p.a_id,p.b_id
  ),'[]'::jsonb) into v_result
  from (
    select a.session_player_id as a_id,
      b.session_player_id as b_id,
      count(*)::integer as games
    from public.tm_game_appearances a
    join public.tm_game_appearances b
      on a.game_id=b.game_id
      and a.team_id=b.team_id
      and a.session_player_id < b.session_player_id
    join public.tm_games g on g.id=a.game_id
    where a.session_id=p_session_id and b.session_id=p_session_id
      and g.status='completed'
    group by a.session_player_id,b.session_player_id
  ) p;
  return coalesce(v_result,'[]'::jsonb);
end $$;
revoke execute on function public.tm_org_teammate_pairs(uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_teammate_pairs(uuid)
  to authenticated;
