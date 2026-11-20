#!/usr/bin/env python3
"""Assemble or verify the original Event Day Manager migration from its SQL components."""
from pathlib import Path
import sys
root=Path(__file__).resolve().parents[2]
parts=['foundation','rotations','game_actions','player_actions','team_history',
       'roster_adjustments','emergency','intra_team_rotation','realtime','public_limits']
files=[root/'db/release/preflight.sql']+[
    root/f'db/drafts/event_day_manager_{part}.sql' for part in parts]+[
    root/'db/tests/security_matrix.sql']
header='-- Event Day Teams Manager initial migration. Apply in a single transaction.\n'
body=header+"set local lock_timeout = '5s';\n\n"+'\n'.join('-- Source: '+str(p.relative_to(root))+'\n'+p.read_text() for p in files)
body+="\nnotify pgrst, 'reload schema';\n"
[target]=list((root/'db/release/migrations').glob('*_event_day_manager.sql'))
if '--check' in sys.argv:
    if target.read_text()!=body: raise SystemExit('Initial migration differs from the SQL components')
    print('PASS: release migration matches reviewed source')
else:
    target.write_text(body)
    print(target.relative_to(root))
