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
  await organizer.goto(new URL('/staging-login', preview).href);
  await organizer.locator('#password').fill(process.env.TM_PREVIEW_PASSWORD);
  await organizer.getByRole('button',{name:'Sign in'}).click();
  await organizer.locator('#tm-source-event').selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await organizer.locator('#tm-start-form button[type="submit"]').click();
  await organizer.getByText('25 available · 0 no-shows · 1 pending',{exact:true}).waitFor();
  assert.equal(await organizer.locator('[data-player-row]').count(), 26);
  assert.equal(await organizer.locator('#tm-roster').getByText('Cancelled Player').count(), 0);
  const first = organizer.locator('[data-player-row]').filter({has:organizer.getByText('Practice Player 1',{exact:true})});
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
  const swap = player.locator('[data-tm-game-action="rotate-teammate"]').first();
  await swap.waitFor();
  const block = swap.locator('..');
  await block.locator('[data-rotate-out]').selectOption({index:1});
  await block.locator('[data-rotate-in]').selectOption({index:1});
  await swap.click();
  await player.locator('#tm-feedback').filter({hasText:/rotation recorded|teammate rotation/i}).waitFor();
  const game = player.locator('.tm-game.is-playing').first();
  await game.locator('[data-report-winner]').selectOption({index:1});
  await game.getByRole('button',{name:'Report winner'}).click();
  await organizer.locator('.tm-game.is-completed').first().waitFor();

  await organizer.locator('#tm-end-rotation').click();
  await organizer.waitForFunction(()=>!document.querySelector('#tm-generate').disabled);
  await publish(6,4);
  const smaller = await player.locator('#tm-public .tm-team').evaluateAll(cards=>cards.map(card=>card.querySelectorAll('li').length));
  assert.deepEqual(smaller.sort((a,b)=>b-a),[5,4,4,4,4,4]);
  await organizer.locator('#tm-end-session').click();
  await player.getByText('No active volleyball session right now.').waitFor();
  await organizer.locator('#tm-final-stats').waitFor();
  assert.match(await organizer.locator('#tm-final-stats-body').innerText(),/Practice Walk-in/);
  assert.deepEqual(problems,[]);
  console.log('PASS: signed-in organizer and anonymous browser completed a 25-player event on the local release.');
} finally {
  await browser.close();
}
