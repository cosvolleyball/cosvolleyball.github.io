-- Game readiness, starts, winner reports and organizer corrections.
--
-- Anonymous callers may start READY games and submit their first valid winner.
-- Every operation locks its session row, validating concurrent actions atomically.
-- No private email, position, gender, skill or participation count is returned.

create schema if not exists tm_internal;
revoke all on schema tm_internal from public, anon, authenticated;

-- Requested one-game substitutions are stored separately from actual
-- appearances. An appearance is inserted only when the game really starts.
create table public.tm_game_subs (
  game_id uuid not null,
  rotation_id uuid not null,
  session_id uuid not null,
  session_player_id uuid not null,
  target_team_id uuid not null,
  recorded_at timestamptz not null default now(),
  primary key (game_id,session_player_id),
  foreign key (game_id,rotation_id)
    references public.tm_games(id,rotation_id) on delete cascade,
  foreign key (rotation_id,session_id)
    references public.tm_rotations(id,session_id) on delete cascade,
  foreign key (session_player_id,session_id)
    references public.tm_session_players(id,session_id) on delete restrict,
  foreign key (target_team_id,rotation_id)
    references public.tm_teams(id,rotation_id) on delete restrict
);
create index tm_game_subs_by_player on public.tm_game_subs(session_player_id);
alter table public.tm_game_subs enable row level security;
revoke all on public.tm_game_subs from public,anon,authenticated;

-- The caller must already hold a FOR UPDATE lock on the session. This
-- helper is in a non-exposed schema; nobody can call it from the Data API.
create function tm_internal.refresh_slots(p_rotation_id uuid)
returns void language plpgsql security invoker set search_path=''
as $$
declare
  v_count integer;
  v_team uuid[];
  v_w1 uuid;
  v_l1 uuid;
  v_w2 uuid;
  v_l2 uuid;
begin
  select array_agg(id order by seed),count(*)
  into v_team,v_count
  from public.tm_teams where rotation_id=p_rotation_id;

  if v_count in (5,6) then
    select g.winner_team_id,
      case when g.winner_team_id = g.team_a_id
        then g.team_b_id else g.team_a_id end
    into v_w1,v_l1
    from public.tm_games g
    where g.rotation_id=p_rotation_id
      and g.round_number=1 and g.court=1 and g.status='completed';

    select g.winner_team_id,
      case when g.winner_team_id = g.team_a_id
        then g.team_b_id else g.team_a_id end
    into v_w2,v_l2
    from public.tm_games g
    where g.rotation_id=p_rotation_id
      and g.round_number=1 and g.court=2 and g.status='completed';

    if v_count=6 then
      update public.tm_games g set
        team_a_id=case when g.court=1 and g.round_number=2 then v_w1
                       when g.court=1 and g.round_number=3 then v_l1
                       when g.court=2 and g.round_number=2 then v_w2
                       when g.court=2 and g.round_number=3 then v_l2 end,
        team_b_id=case when g.court=1 then v_team[3] else v_team[6] end
      where g.rotation_id=p_rotation_id and g.round_number>1
        and g.status in ('scheduled','ready');
    else
      update public.tm_games g set
        team_a_id=case
          when g.round_number=2 and g.court=1 then v_w1
          when g.round_number=2 and g.court=2 then v_w2
          when g.round_number=3 and g.court=1 then v_w1
          when g.round_number=3 and g.court=2 then v_w2 end,
        team_b_id=case
          when g.round_number=2 and g.court=1 then v_team[3]
          when g.round_number=2 and g.court=2 then v_l1
          when g.round_number=3 and g.court=1 then v_l2
          when g.round_number=3 and g.court=2 then v_team[3] end
      where g.rotation_id=p_rotation_id and g.round_number>1
        and g.status in ('scheduled','ready');
    end if;
  end if;

  -- A game is ready only after the prior game on its court and every
  -- earlier game involving either of its teams is COMPLETED. This handles
  -- five-team cross-court movement without unnecessarily synchronizing
  -- the six-team courts.
  update public.tm_games g set status=case
    when g.team_a_id is not null and g.team_b_id is not null
      and not exists (
        select 1 from public.tm_games prev
        where prev.rotation_id=g.rotation_id
          and prev.round_number<g.round_number
          and (prev.court=g.court
            or prev.team_a_id in (g.team_a_id,g.team_b_id)
            or prev.team_b_id in (g.team_a_id,g.team_b_id))
          and prev.status<>'completed'
      )
      and not exists (
        select 1 from public.tm_games live
        where live.rotation_id=g.rotation_id and live.status='playing'
          and (live.team_a_id in (g.team_a_id,g.team_b_id)
            or live.team_b_id in (g.team_a_id,g.team_b_id))
      )
    then 'ready' else 'scheduled' end
  where g.rotation_id=p_rotation_id and g.status in ('scheduled','ready');
end $$;

-- The internal scheduler is called exclusively from audited SECURITY DEFINER
-- RPCs. Revoking default PUBLIC EXECUTE is defense-in-depth even though
-- tm_internal is not exposed in PostgREST and its schema USAGE is denied.
revoke execute on function tm_internal.refresh_slots(uuid)
  from public,anon,authenticated;

-- A game can be started publicly only after its participants are available.
-- For six-team sessions, the resting team on the SAME court can lend
-- volunteers via tm_public_record_sub below. For five-team sessions,
-- temporary subs are prohibited; transfer between games instead.
create function public.tm_public_start_game(p_game_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_game public.tm_games%rowtype;
  v_rotation_status text;
  v_format smallint;
  v_team uuid;
  v_sub_count integer;
  v_available_count integer;
  v_regular_limit integer;
  v_started_count integer;
  v_minimum integer := 4;
begin
  select s.* into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
  for update of s;
  if not found then
    raise exception 'No active session for this game' using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  select status,playing_format into v_rotation_status,v_format
    from public.tm_rotations where id=v_game.rotation_id;
  if v_rotation_status<>'published' then
    raise exception 'Rotation is not published' using errcode='22023';
  end if;
  perform tm_internal.refresh_slots(v_game.rotation_id);
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'ready' or v_game.team_a_id is null
     or v_game.team_b_id is null then
    raise exception 'Game is not ready; refresh the schedule'
      using errcode='22023';
  end if;

  -- Disallow the same team playing two simultaneous games on ANY court.
  if exists (
    select 1 from public.tm_games g
    where g.rotation_id=v_game.rotation_id and g.status='playing'
      and (g.team_a_id in (v_game.team_a_id,v_game.team_b_id)
        or g.team_b_id in (v_game.team_a_id,v_game.team_b_id))
  ) then
    raise exception 'One of these teams is already playing'
      using errcode='22023';
  end if;

  foreach v_team in array array[v_game.team_a_id,v_game.team_b_id] loop
    select count(*) into v_sub_count from public.tm_game_subs subs
    join public.tm_session_players sp on sp.id=subs.session_player_id
    where subs.game_id=p_game_id and subs.target_team_id=v_team
      and sp.attendance in ('present','waiting')
      and not exists(
        select 1 from public.tm_game_appearances a
        join public.tm_games g on g.id=a.game_id
        where a.session_player_id=sp.id and g.status='playing'
      );
    -- Reject stale subs rather than silently dropping one after a departure.
    if v_sub_count<>(
      select count(*) from public.tm_game_subs
      where game_id=p_game_id and target_team_id=v_team
    ) then
      raise exception 'A planned substitute is unavailable'
        using errcode='22023';
    end if;
    v_regular_limit := greatest(v_format-v_sub_count,0);
    select count(*) into v_available_count
    from public.tm_memberships m
    join public.tm_session_players sp on sp.id=m.session_player_id
    where m.rotation_id=v_game.rotation_id and m.team_id=v_team
      and sp.attendance in ('present','waiting')
      and not exists(
        select 1 from public.tm_game_appearances a
        join public.tm_games g on g.id=a.game_id
        where a.session_player_id=sp.id and g.status='playing'
      );

    if least(v_available_count,v_regular_limit)+v_sub_count<v_minimum then
      raise exception 'A team needs at least four available players'
        using errcode='22023';
    end if;
  end loop;

  -- Selection intentionally prioritizes those who have played fewer actual
  -- regular games; this rotates the fifth roster member into a 4v4 lineup.
  foreach v_team in array array[v_game.team_a_id,v_game.team_b_id] loop
    select count(*) into v_sub_count from public.tm_game_subs
      where game_id=p_game_id and target_team_id=v_team;
    v_regular_limit := greatest(v_format-v_sub_count,0);
    insert into public.tm_game_appearances
      (game_id,rotation_id,session_id,session_player_id,team_id,is_substitute)
    select p_game_id,v_game.rotation_id,v_session.id,ranked.player_id,v_team,false
    from (
      select sp.id as player_id
      from public.tm_memberships m
      join public.tm_session_players sp on sp.id=m.session_player_id
      where m.rotation_id=v_game.rotation_id and m.team_id=v_team
        and sp.attendance in ('present','waiting')
        and not exists (
          select 1 from public.tm_game_appearances a
          join public.tm_games g on g.id=a.game_id
          where a.session_player_id=sp.id and g.status='playing'
        )
      order by (
        select count(*) from public.tm_game_appearances a
        join public.tm_games g on g.id=a.game_id
        where a.session_player_id=sp.id and not a.is_substitute
          and g.status in ('completed','playing')
      ),sp.id
      limit v_regular_limit
    ) ranked;

    insert into public.tm_game_appearances
      (game_id,rotation_id,session_id,session_player_id,team_id,is_substitute)
    select p_game_id,v_game.rotation_id,v_session.id,
      subs.session_player_id,v_team,true
    from public.tm_game_subs subs
    where subs.game_id=p_game_id and subs.target_team_id=v_team;
  end loop;
  -- Above insertion can never reuse someone who is already in another
  -- playing game because all sessions serialize on the tm_sessions lock.
  update public.tm_games set status='playing',started_at=now()
    where id=p_game_id and status='ready';
  if not found then
    raise exception 'Someone already started this game'
      using errcode='22023';
  end if;
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session.id,'start_game',
      jsonb_build_object('game_id',p_game_id));
  perform tm_internal.refresh_slots(v_game.rotation_id);
end $$;

-- First valid result wins. Second/stale result attempts always fail.
create function public.tm_public_report_winner(
  p_game_id uuid,p_winner_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_rotation uuid;
  v_game public.tm_games%rowtype;
begin
  select s.id,r.id into v_session,v_rotation
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active' and r.status='published'
  for update of s;
  if not found then
    raise exception 'Game is outside an active rotation'
      using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'playing' then
    raise exception 'Game already completed or has not started'
      using errcode='22023';
  end if;
  if p_winner_team_id is null
     or p_winner_team_id not in (v_game.team_a_id,v_game.team_b_id) then
    raise exception 'Winner must be one of the playing teams'
      using errcode='22023';
  end if;
  update public.tm_games set status='completed',
    winner_team_id=p_winner_team_id,completed_at=now()
  where id=p_game_id and status='playing';
  if not found then
    raise exception 'Winner already reported' using errcode='22023';
  end if;

  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session,'report_winner',
      jsonb_build_object('game_id',p_game_id,
        'winner_team_id',p_winner_team_id));
  perform tm_internal.refresh_slots(v_rotation);
  if not exists(
    select 1 from public.tm_games where rotation_id=v_rotation
      and status<>'completed'
  ) then
    update public.tm_rotations set status='completed',finished_at=now()
    where id=v_rotation and status='published';
  end if;
end $$;

-- Organizer correction is allowed while downstream matches depending
-- on an opening result have NOT started. Last-round games remain correctable
-- even after a six-game rotation automatically becomes 'completed', while
-- the event-day session is still active. Four-team round-robin pairings do
-- not depend on winners, so their results can be corrected independently.
create function public.tm_org_correct_winner(
  p_game_id uuid,p_winner_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_rotation uuid;
  v_game public.tm_games%rowtype;
  v_team_count integer;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.id,r.id into v_session,v_rotation
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
    and r.status in ('published','completed')
  for update of s;
  if not found then
    raise exception 'No active published game to correct'
      using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'completed'
     or p_winner_team_id not in (v_game.team_a_id,v_game.team_b_id) then
    raise exception 'Only a completed game can have its winner corrected'
      using errcode='22023';
  end if;
  if v_game.winner_team_id=p_winner_team_id then return; end if;
  select count(*) into v_team_count from public.tm_teams
    where rotation_id=v_rotation;

  if v_game.round_number=1 and v_team_count>4 and exists(
    select 1 from public.tm_games dependent
    where dependent.rotation_id=v_rotation
      and dependent.round_number>1
      and (dependent.started_at is not null
        or dependent.status in ('playing','completed'))
      and (
        (v_team_count=6 and dependent.court=v_game.court)
        or
        (v_team_count=5 and
          ((v_game.court=1 and
            (dependent.round_number=2 or
             (dependent.round_number=3 and dependent.court=1)))
          or
           (v_game.court=2 and
            ((dependent.round_number=2 and dependent.court=2)
             or dependent.round_number=3))))
      )
  ) then
    raise exception 'Cannot change winner after dependent match started'
      using errcode='22023';
  end if;

  -- A six-team opening-winner correction can change which team is
  -- resting in its next game. Remove planned subs for that court before
  -- rewiring, or a former resting-team player could end up playing both.
  -- Five-team games never have temporary substitutes.
  if v_game.round_number=1 and v_team_count=6 then
    delete from public.tm_game_subs subs
    using public.tm_games dependent
    where subs.game_id=dependent.id
      and dependent.rotation_id=v_rotation
      and dependent.court=v_game.court
      and dependent.round_number>1
      and dependent.status in ('scheduled','ready');
  end if;

  update public.tm_games set winner_team_id=p_winner_team_id
    where id=p_game_id;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (v_session,'correct_winner',auth.uid(),
      jsonb_build_object('game_id',p_game_id,
        'previous',v_game.winner_team_id,'new',p_winner_team_id));
  perform tm_internal.refresh_slots(v_rotation);
end $$;

-- Read-only public information about planned temporary substitutes.
-- This exposes display names and team IDs, not private profiles.
create function public.tm_public_game_subs(p_game_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id',sp.id,
    'name',sp.display_name,
    'team_id',subs.target_team_id
  ) order by sp.display_name,sp.id),'[]'::jsonb)
  from public.tm_game_subs subs
  join public.tm_session_players sp on sp.id=subs.session_player_id
  join public.tm_games g on g.id=subs.game_id
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where subs.game_id=p_game_id and s.status='active'
    and r.status='published'
$$;

revoke execute on function tm_internal.refresh_slots(uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_start_game(uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_report_winner(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_org_correct_winner(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_game_subs(uuid)
  from public,anon,authenticated;
grant execute on function public.tm_public_start_game(uuid)
  to anon,authenticated;
grant execute on function public.tm_public_report_winner(uuid,uuid)
  to anon,authenticated;
grant execute on function public.tm_org_correct_winner(uuid,uuid)
  to authenticated;
grant execute on function public.tm_public_game_subs(uuid)
  to anon,authenticated;
