#!/usr/bin/env python3
"""Disposable PostgreSQL only: force an action to queue behind game/rotation closure."""
import json
import os
import subprocess
import time

PSQL = ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
AUTH = "select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);"

def sql(query):
    return subprocess.check_output(PSQL + ['-c', query], text=True).strip()

def fixture(team_count, playing):
    sql(f"""
    create table if not exists public.tm_test_stale_keys(data jsonb);
    truncate public.tm_test_stale_keys;
    do $$ declare s uuid; r uuid; rev bigint; payload jsonb:='[]'; members jsonb; i int;
    begin
      perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
      for s in select id from public.tm_sessions where status='active' loop
        perform public.tm_org_end_session(s);
      end loop;
      s:=public.tm_org_start_session('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',6::smallint);
      for i in 1..{team_count * 7} loop
        perform public.tm_org_add_walkin(s,'Queued player '||i,'queued-'||i||'@example.invalid');
      end loop;
      for i in 1..{team_count} loop
        select jsonb_agg(id order by id) into members from
          (select id from public.tm_session_players where session_id=s order by id limit 7 offset (i-1)*7) p;
        payload:=payload||jsonb_build_array(jsonb_build_object('seed',i,'playerIds',members));
      end loop;
      select revision into rev from public.tm_sessions where id=s;
      perform public.tm_org_save_draft(s,rev,payload);
      select revision into rev from public.tm_sessions where id=s;
      r:=public.tm_org_publish_draft(s,rev);
      insert into public.tm_test_stale_keys values(jsonb_build_object('session',s,'rotation',r));
    end $$;
    """)
    keys = json.loads(sql('select data from public.tm_test_stale_keys'))
    keys.update(json.loads(sql(f"""select jsonb_build_object('game',g.id,'team',g.team_a_id,'other',g.team_b_id,
      'source',(select m.session_player_id from public.tm_memberships m join public.tm_teams t on t.id=m.team_id
        where t.rotation_id=g.rotation_id and t.seed=3 limit 1))
      from public.tm_games g where rotation_id='{keys['rotation']}' and court=1 and round_number=1""")))
    if playing:
        sql(f"select public.tm_public_start_game('{keys['game']}')")
    on_court = (f"and exists (select 1 from public.tm_game_appearances a where a.game_id='{keys['game']}' and a.session_player_id=m.session_player_id)"
                if playing else "")
    keys.update(json.loads(sql(f"""select jsonb_build_object(
      'out',(select m.session_player_id from public.tm_memberships m where m.team_id='{keys['team']}'
        {on_court} limit 1),
      'bench',(select m.session_player_id from public.tm_memberships m where m.team_id='{keys['team']}'
        and not exists(select 1 from public.tm_game_appearances a where a.game_id='{keys['game']}' and a.session_player_id=m.session_player_id) limit 1))""")))
    return keys

def race(label, k, first, second):
    owner = subprocess.Popen(PSQL, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    waiter = None
    try:
        owner.stdin.write(f"begin;\n{AUTH}\nselect id from public.tm_sessions where id='{k['session']}' for update;\n\\echo LOCKED\n")
        owner.stdin.flush()
        while True:
            line = owner.stdout.readline()
            if line.strip() == 'LOCKED': break
            if not line: raise RuntimeError('Lock owner failed: '+owner.stderr.read())
        waiter = subprocess.Popen(PSQL+['-c',AUTH+second], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={**os.environ, 'PGAPPNAME':'tm_stale_action_waiter'})
        for _ in range(100):
            if sql("select count(*) from pg_stat_activity where application_name='tm_stale_action_waiter' and wait_event_type='Lock'") == '1': break
            if waiter.poll() is not None: raise RuntimeError('Queued action did not wait')
            time.sleep(0.03)
        else: raise RuntimeError('Action never waited for session lock')
        owner.stdin.write(first+';\ncommit;\n\\q\n');owner.stdin.flush()
        output, errors = owner.communicate(timeout=15)
        if owner.returncode: raise RuntimeError(errors)
        output, errors = waiter.communicate(timeout=15)
        if waiter.returncode == 0:
            print('FAIL:',label,'was accepted after closure')
            return False
        # A semantic stale-state rejection, not an unrelated SQL/test error.
        expected = ['A transfer needs a short team'] if label == 'transfer-vacancy' else [
            'active game','live game','active published','no longer active','Active published','eligible for lineup']
        if not any(text in errors for text in expected):
            raise RuntimeError('Unexpected rejection: '+errors)
        print('PASS:',label)
        return True
    finally:
        for process in [owner,waiter]:
            if process is not None and process.poll() is None:
                process.kill();process.wait()

# These scenarios own the synthetic sessions in the preceding contract suite.
if (os.environ.get('PGHOST') not in ('127.0.0.1', 'localhost')
        or sql("select to_regclass('public.tm_test_concurrency_keys') is not null") != 't'):
    raise SystemExit('Run only in the local database contract fixture')

results=[]
for kind in ['emergency','teammate','appearance','roster','transfer','transfer-correction','transfer-vacancy','end-rotation']:
    k=fixture(5 if kind.startswith('transfer') else 6,kind in ['emergency','teammate','appearance'])
    finish=f"select public.tm_org_end_rotation('{k['rotation']}',true)"
    if kind in ['emergency','teammate']:
        finish=f"select public.tm_public_report_winner('{k['game']}','{k['team']}')"
        target=k['source'] if kind=='emergency' else k['bench']
        fn='tm_public_emergency_sub' if kind=='emergency' else 'tm_public_rotate_teammate'
        queued=f"select public.{fn}('{k['game']}','{k['out']}','{target}')"
    elif kind=='appearance':
        queued=f"select public.tm_org_correct_appearance('{k['game']}','{k['out']}','{k['bench']}')"
    elif kind=='roster':
        incoming=sql(AUTH+f"select public.tm_org_set_attendance('{k['out']}','departed');select public.tm_org_add_walkin('{k['session']}','Late player','queued-late@example.invalid')").splitlines()[-1]
        queued=f"select public.tm_org_adjust_roster('{k['rotation']}','{incoming}','{k['team']}','{k['out']}')"
    elif kind.startswith('transfer'):
        # All teams start with seven. Two breaks leave one open spot in 6v6.
        sql(AUTH+f"""select public.tm_org_set_attendance(session_player_id,'break') from (
            select session_player_id from public.tm_memberships where team_id='{k['other']}' limit 2) p""")
        if kind=='transfer-correction':
            sql(f"select public.tm_public_transfer('{k['rotation']}','{k['out']}','{k['other']}')")
            queued=f"select public.tm_org_correct_transfer('{k['rotation']}','{k['out']}','{k['team']}')"
        elif kind=='transfer-vacancy':
            finish=f"select public.tm_public_transfer('{k['rotation']}','{k['out']}','{k['other']}')"
            queued=f"select public.tm_public_transfer('{k['rotation']}','{k['source']}','{k['other']}')"
        else:
            queued=f"select public.tm_public_transfer('{k['rotation']}','{k['out']}','{k['other']}')"
    else:
        queued=finish
    results.append(race(kind,k,finish,queued))
sql(AUTH+"select public.tm_org_end_session(id) from public.tm_sessions where status='active'")
if not all(results): raise SystemExit(1)
