// Two independent browser sessions talking to real Auth, PostgREST and Realtime.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const preview = new URL(process.env.TM_PREVIEW_URL);
if (preview.hostname !== '127.0.0.1') throw Error('This test needs the loopback practice gym.');
const browser = await chromium.launch({headless:true});
try {
  const host = await browser.newContext({viewport:{width:1024,height:900}});
  const guest = await browser.newContext({viewport:{width:390,height:844}, isMobile:true,hasTouch:true});
  const organizer = await host.newPage();
  const player = await guest.newPage();
  const problems = [];
  for (const page of [organizer, player]) {
    page.setDefaultTimeout(25000);
    page.on('dialog', dialog => dialog.accept());
    page.on('pageerror', error => problems.push(error.message));
    // The manager loads its pinned SDK from esm.sh. Every database request
    // must go to this run's local instance.
    await page.route(/https?:\/\/[^/]+\.supabase\.co\//, async route => {
      problems.push('Unexpected hosted database request');
      await route.abort();
    });
  }
  await player.goto(preview.href);
  await player.getByText('No active volleyball session right now.').waitFor();
  await player.locator('nav').getByRole('link',{name:'Organizer Login',exact:true}).waitFor();
  await organizer.goto(new URL('/staging-login', preview).href);
  await organizer.locator('#password').fill(process.env.TM_PREVIEW_PASSWORD);
  await organizer.getByRole('button',{name:'Sign in'}).click();
  await organizer.locator('nav a.is-signed-in').filter({hasText:'Organizer Dashboard'}).waitFor();
  await organizer.locator('#tm-source-event').selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await organizer.locator('#tm-start-form button[type="submit"]').click();
  await organizer.getByText('25 available · 0 no-shows · 1 pending',{exact:true}).waitFor();
  assert.equal(await organizer.locator('[data-player-row]').count(), 26);
  assert.equal(await organizer.locator('#tm-roster').getByText('Cancelled Player').count(), 0);
  const first = organizer.locator('[data-player-row]').filter({has:organizer.getByText('Practice Player 1',{exact:true})});
  await first.locator('[data-skill]').selectOption('9');
  await first.locator('[data-gender]').selectOption('female');
  await first.locator('.tm-position-trigger').click();
  await first.getByLabel('Outside',{exact:true}).check();
  await first.getByLabel('Setter',{exact:true}).check();
  assert(await first.getByLabel('Middle',{exact:true}).isDisabled());
  await first.getByLabel('Flex (all positions)',{exact:true}).check();
  assert.equal(await first.locator('[data-position]:checked').count(),1);
  await first.getByRole('button',{name:'Done',exact:true}).click();
  await first.getByRole('button',{name:'Save',exact:true}).click();
  await organizer.getByText('Player profile saved.',{exact:false}).waitFor();
  await organizer.reload();
  await first.locator('[data-position-summary]').filter({hasText:'Flex'}).waitFor();
  assert.equal(await first.locator('[data-skill]').inputValue(),'9');
  assert.equal(await first.locator('[data-gender]').inputValue(),'female');
  await organizer.locator('nav a.is-signed-in').filter({hasText:'Organizer Dashboard'}).waitFor();
  await first.getByRole('button',{name:'Mark no-show'}).click();
  await organizer.getByText('24 available · 1 no-shows · 1 pending',{exact:true}).waitFor();
  await organizer.locator('#tm-walkin-name').fill('Practice Walk-in');
  await organizer.locator('#tm-walkin-email').fill('arrival@phone-review.example.invalid');
  await organizer.locator('#tm-walkin-form button').click();
  await organizer.getByText('25 available · 1 no-shows · 1 pending',{exact:true}).waitFor();

  async function publish(teamCount, format) {
    await organizer.locator('#tm-team-count').selectOption(String(teamCount));
    await organizer.locator('#tm-draft-format').selectOption(String(format));
    await organizer.locator('#tm-generate').click();
    // Move an intact roster into a different opening slot, then undo once.
    const draft = organizer.locator('#tm-draft .tm-team');
    const names = card => card.locator('[data-swap-player]').evaluateAll(buttons=>buttons.map(button=>button.dataset.swapPlayer));
    const firstPlayers = await names(draft.first());
    await organizer.locator('#slot-1').selectOption('3');
    await organizer.locator('[data-swap-slot="1"]').click();
    assert.deepEqual(await names(draft.nth(2)), firstPlayers);
    await organizer.locator('#tm-undo').click();
    assert.deepEqual(await names(draft.first()), firstPlayers);
    await organizer.locator('#tm-save-draft').click();
    await organizer.locator('#tm-publish').click();
    await player.waitForFunction(n=>document.querySelectorAll('#tm-public .tm-team').length===n, teamCount);
  }
  await publish(4,6);
  const sizes = await player.locator('#tm-public .tm-team').evaluateAll(cards=>cards.map(card=>card.querySelectorAll('li').length));
  assert.deepEqual(sizes.sort((a,b)=>b-a),[7,6,6,6]);
  assert.equal(await player.locator('#tm-public').getByText('Practice Walk-in',{exact:true}).count(),1);
  assert.equal(await player.locator('#tm-public').getByText('Practice Player 1',{exact:true}).count(),0);
  assert(await player.locator('#tm-organizer').isHidden());

  // Start both opening courts so the seven-player roster is guaranteed to be playing.
  for (const court of await player.locator('.tm-court').all())
    await court.locator('[data-tm-game-action="start"]').first().click();
  await player.waitForFunction(()=>document.querySelectorAll('.tm-game.is-playing').length===2);
  const seven=player.locator('#tm-public .tm-team').filter({has:player.locator('li:nth-child(7)')});
  const teamLabel=await seven.getByRole('heading').innerText();
  const members=await seven.locator('li').allTextContents();
  const game=player.locator('.tm-game.is-playing').filter({has:player.locator('option').filter({hasText:teamLabel})});
  assert.equal(await game.locator('button').count(),1);
  assert.equal(await game.locator('select').count(),1);
  await game.locator('[data-report-winner]').selectOption({label:teamLabel});
  await game.getByRole('button',{name:'Report winner'}).click();
  await organizer.locator('.tm-game.is-completed').first().waitFor();

  await organizer.locator('#tm-end-rotation').click();
  await organizer.waitForFunction(()=>!document.querySelector('#tm-generate').disabled);
  await publish(6,4);
  const smaller = await player.locator('#tm-public .tm-team').evaluateAll(cards=>cards.map(card=>card.querySelectorAll('li').length));
  assert.deepEqual(smaller.sort((a,b)=>b-a),[5,4,4,4,4,4]);
  await organizer.locator('#tm-end-rotation').click();
  await organizer.waitForFunction(()=>!document.querySelector('#tm-generate').disabled);
  await publish(5,4);
  const shortTeam = player.locator('#tm-public .tm-team').first();
  const names = await shortTeam.locator('li').allTextContents();
  assert.equal(names.length,5);
  assert.equal(await player.locator('.tm-transfer').count(),0);
  // Five players become four, then three. Only the second break opens a vacancy.
  for (const [index,name] of names.slice(0,2).entries()) {
    const row=organizer.locator('[data-player-row]').filter({has:organizer.getByText(name,{exact:true})});
    await row.locator('[data-attendance]').selectOption('break');
    await organizer.locator('#tm-roster-count').filter({hasText:(24-index)+' available'}).waitFor();
  }
  const transfer = player.locator('.tm-transfer');
  await transfer.waitFor();
  assert.equal(await transfer.locator('#tm-transfer-target option').count(),2);
  await transfer.locator('#tm-transfer-target').selectOption({index:1});
  await transfer.locator('#tm-transfer-player').selectOption({index:1});
  await transfer.getByRole('button',{name:'Transfer until reshuffle'}).click();
  await player.locator('#tm-feedback').filter({hasText:'Player transferred'}).waitFor();
  await transfer.waitFor({state:'detached'});
  await organizer.locator('#tm-end-session').click();
  await player.getByText('No active volleyball session right now.').waitFor();
  await organizer.locator('#tm-final-stats').waitFor();
  assert.match(await organizer.locator('#tm-final-stats-body').innerText(),/Practice Walk-in/);
  const winners=await organizer.locator('#tm-final-stats-body tbody tr').evaluateAll(rows=>
    rows.filter(r=>r.cells[4].textContent==='1' && r.cells[2].textContent==='1').map(r=>r.cells[0].textContent));
  assert.deepEqual(winners.sort(),members.sort());
  assert.deepEqual(problems,[]);
  console.log('PASS: signed-in organizer and anonymous browser completed a 25-player event on the local release.');
} finally {
  await browser.close();
}
