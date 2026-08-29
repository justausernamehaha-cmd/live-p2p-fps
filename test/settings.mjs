// The settings panel: rebinding keys, several keys per action, hold-or-toggle
// for the four actions that support it, the sprint button a phone needs, and the
// pause that draws over the game instead of replacing it.
//
// The assertions are against consequences, not appearances: a rebound key is
// proved by the player moving, a second key by the player moving with either of
// them, a latched jump by the player leaving the ground again and again with
// nothing held down.
//
//   ./serve.sh 8080 &   then   node test/settings.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 820 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));

await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.evaluate(() => localStorage.removeItem('pa.binds'));
await page.reload();
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'set');
await page.fill('#roominput', 'set-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1300);

const R = {};
const fail = [];
// A missing panel or a missing row makes every later click hang for thirty
// seconds and die as a timeout. Stop at the cause instead, and say what it was.
const must = async (ok, why) => {
  if (ok) return;
  console.log(JSON.stringify(R, null, 2));
  console.log('FAIL: ' + why);
  await browser.close();
  process.exit(1);
};
const open = async () => { await page.keyboard.press('Backquote'); await page.waitForTimeout(220); };
const close = async () => { await page.keyboard.press('Backquote'); await page.waitForTimeout(220); };

// every row, as [label, [key labels]]
const rows = () => page.evaluate(() => [...document.querySelectorAll('#keybinds .bindrow')].map(r => [
  r.querySelector('.bindname').textContent,
  [...r.querySelectorAll('.bindkey')].map(b => b.textContent)
]));
const keysOf = async label => ((await rows()).find(r => r[0] === label) || [null, []])[1];
// does this key actually walk the player forward? yaw 0 faces -z
const walks = code => page.evaluate(async code => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const real = g.world.boxes;
  g.world.boxes = real.filter(b => b.max.y === 0 && b.max.x - b.min.x > 50);
  g.player.pos = { x: 0, y: 0.2, z: 0 };
  g.player.vel = { x: 0, y: 0, z: 0 };
  g.player.yaw = 0; g.player.pitch = 0;
  await sleep(180);
  const z0 = g.player.pos.z;
  dispatchEvent(new KeyboardEvent('keydown', { code }));
  await sleep(320);
  dispatchEvent(new KeyboardEvent('keyup', { code }));
  await sleep(60);
  g.world.boxes = real;
  return +(g.player.pos.z - z0).toFixed(2);
}, code);

// --------------------------------------------- the panel opens on ` and not on =
await open();
R.openedOnBacktick = await page.isVisible('#editpanel');
await close();
R.closedAgain = !(await page.isVisible('#editpanel'));
await page.keyboard.press('Equal');
await page.waitForTimeout(220);
R.equalsDoesNothing = !(await page.isVisible('#editpanel'));
await must(R.openedOnBacktick, '` did not open the settings panel');
await must(R.closedAgain, '` did not close it again');
await open();

// -------------------------------------------------------------- the key rows
R.rows = await rows();
await must(R.rows.length === 16, 'expected 16 key rows, got ' + R.rows.length);
R.forwardKeys = await keysOf('Forward');
R.sprintKeys = await keysOf('Sprint');
R.settingsKeys = await keysOf('Open settings');
R.menuKeys = await keysOf('Open menu');

// ------------------------------------------------------- rebind forward to I
await page.click('#keybinds .bindrow[data-action=fwd] .bindkey');
R.arming = await page.evaluate(() =>
  document.querySelector('#keybinds .bindrow:has(.arming)')?.dataset.action);
await page.keyboard.press('KeyI');
await page.waitForTimeout(150);
R.afterRebind = await keysOf('Forward');
R.savedBinds = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('pa.binds'))?.KeyI ?? null; } catch { return null; }
});
await close();
R.rebindWorks = { withI: await walks('KeyI'), withW: await walks('KeyW') };

// ------------------------------------------ + adds a second key for the action
await open();
await page.click('#keybinds .bindrow[data-action=fwd] .bindadd');
await page.keyboard.press('KeyO');
await page.waitForTimeout(150);
R.afterAdd = await keysOf('Forward');
await close();
R.bothKeysWork = { withI: await walks('KeyI'), withO: await walks('KeyO') };

// ------------------------------------- Backspace takes one key off, not the row
await open();
await page.click('#keybinds .bindrow[data-action=fwd] .bindkey');   // the first one, I
await page.keyboard.press('Backspace');
await page.waitForTimeout(150);
R.afterRemove = await keysOf('Forward');
await close();
R.afterRemoveWorks = { withI: await walks('KeyI'), withO: await walks('KeyO') };

// a rebind survives a reload, because it is the saved map that is read
await page.reload();
await page.waitForFunction(() => window.__paStarted);
R.survivedReload = await page.evaluate(() => window.game.input.binds.KeyO);
await page.fill('#nameinput', 'set');
await page.fill('#roominput', 'set2-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(1300);

// ------------------------------------- Open settings is itself a binding now
await open();
await page.click('#keybinds .bindrow[data-action=settings] .bindkey');
await page.keyboard.press('KeyU');
await page.waitForTimeout(200);
await page.keyboard.press('KeyU');                        // closes it, with the new key
await page.waitForTimeout(220);
R.newSettingsKeyCloses = !(await page.isVisible('#editpanel'));
await page.keyboard.press('Backquote');                   // the old key is gone
await page.waitForTimeout(220);
R.oldSettingsKeyDead = !(await page.isVisible('#editpanel'));
await page.keyboard.press('KeyU');
await page.waitForTimeout(220);
R.newSettingsKeyOpens = await page.isVisible('#editpanel');

// -------------------------------------------------------------- reset the keys
await page.click('#resetbinds');
await page.waitForTimeout(150);
R.afterReset = await page.evaluate(() => ({
  w: window.game.input.binds.KeyW,
  oGone: window.game.input.binds.KeyO === undefined,
  uGone: window.game.input.binds.KeyU === undefined,
  settings: window.game.input.binds.Backquote,
  menu: window.game.input.binds.Escape
}));
R.forwardAfterReset = await keysOf('Forward');

// ------------------------------- the designer has its own keyboard, hidden here
R.designRowsPresent = await page.evaluate(() =>
  [...document.querySelectorAll('#designbinds .bindrow')].map(r => r.dataset.action));
R.designSectionHiddenInAMatch = await page.evaluate(() =>
  getComputedStyle(document.querySelector('.designonly')).display === 'none');
R.designDefaults = await page.evaluate(() => ({
  del: window.game.input.designAction('KeyT'),
  rotate: window.game.input.designAction('KeyR'),
  shape: window.game.input.designAction('KeyF'),
  // the same physical keys mean different things in a match, and must not collide
  matchR: window.game.input.binds.KeyR,
  matchF: window.game.input.binds.KeyF,
  matchQ: window.game.input.binds.KeyQ
}));

// -------------------------------------------- hold/toggle now covers four actions
R.modeRows = await page.evaluate(() =>
  [...document.querySelectorAll('.moderow')].map(r => r.dataset.action));
await must(String(R.modeRows) === 'crouch,ads,sprint,jump',
           'hold/toggle rows are wrong: ' + R.modeRows);

// sprint as a toggle: one tap and it stays on with nothing held
await page.click('.modes button[data-action=sprint][data-mode=toggle]');
await page.waitForTimeout(120);
await close();
R.sprintLatches = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
  await sleep(200);
  const afterTap = g.input.down('sprint');
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
  await sleep(200);
  return { afterTap, afterSecondTap: g.input.down('sprint') };
});

// jump as a toggle is the mobile bunny hop: one tap and the hops keep coming
await open();
await page.click('.modes button[data-action=jump][data-mode=toggle]');
await page.waitForTimeout(120);
await close();
R.jumpLatches = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn({ x: 0, y: 0.2, z: 0 });
  await sleep(400);
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
  const held = g.input.down('jump');
  let hops = 0, wasGround = g.player.onGround;
  const t0 = performance.now();
  while (performance.now() - t0 < 2000) {
    await sleep(16);
    if (wasGround && !g.player.onGround) hops++;
    wasGround = g.player.onGround;
  }
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
  await sleep(300);
  return { held, hops, releasedOnSecondTap: !g.input.down('jump') };
});

// -------------------------------------------------------- the sprint touch button
R.sprintButton = await page.evaluate(async () => {
  const el = document.querySelector('.tbtn[data-btn=sprint]');
  if (!el) return { exists: false };
  const g = window.game;
  g.input.setToggleMode('sprint', false);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
  const whileDown = g.input.down('sprint');
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
  await new Promise(f => setTimeout(f, 60));
  return { exists: true, whileDown, afterUp: g.input.down('sprint'),
           inTouchPad: !!el.closest('#tbuttons') };
});

// ----------------- leaving the panel gives one 3s window, not two of anything
// The point of merging them is that the shield and the weapon lock are the same
// state, so the test is: while it holds you cannot be hurt *and* cannot fire,
// and when it ends both come back together. Firing is checked by whether a
// round actually left the magazine, not by reading a timestamp.
R.protection = await page.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const tryToFire = () => {
    g.loadout.state[g.loadout.index].reloadEnd = 0;
    g.loadout.state[g.loadout.index].mag = 30;
    g.loadout.nextShot = 0;
    g.input.held.add('fire');
    g.input.justPressed.add('fire');
    g._fire(performance.now() / 1000, g.input);
    g.input.held.delete('fire');
    g.input.justPressed.delete('fire');
    return g.loadout.state[g.loadout.index].mag < 30;
  };

  g.input.setToggleMode('jump', false);
  g._startEdit();
  await sleep(150);
  const shieldedWhileEditing = g.shielded;
  const hp = g.player.hp;
  g._takeHit('someone', { dmg: 90 });
  const damageIgnored = g.player.hp === hp;
  g._endEdit();
  await sleep(100);
  const t = performance.now();
  const hp2 = g.player.hp;
  g._takeHit('someone', { dmg: 90 });
  return {
    shieldedWhileEditing, damageIgnored,
    protectedFor: +((g.protectedUntil - t) / 1000).toFixed(1),
    stillShielded: g.shielded,
    damageStillIgnored: g.player.hp === hp2,
    firedWhileProtected: tryToFire(),
    // one field, not two: there is no second timer left to disagree with it
    hasOnlyOneTimer: g.shieldUntil === undefined && g.fireLockUntil === undefined
  };
});
await page.waitForTimeout(3100);
R.protectionGone = await page.evaluate(() => {
  const g = window.game;
  g.loadout.state[g.loadout.index].reloadEnd = 0;
  g.loadout.state[g.loadout.index].mag = 30;
  g.loadout.nextShot = 0;
  g.input.held.add('fire');
  g.input.justPressed.add('fire');
  g._fire(performance.now() / 1000, g.input);
  g.input.held.delete('fire');
  g.input.justPressed.delete('fire');
  return {
    shielded: g.shielded,
    timerPassed: performance.now() >= g.protectedUntil,
    firedAfterwards: g.loadout.state[g.loadout.index].mag < 30
  };
});

// ----------------------------------------------------- pause draws over the game
R.pause = await page.evaluate(async () => {
  const g = window.game;
  const frames = () => new Promise(res => {
    const t0 = performance.now(); let n = 0;
    (function c() { n++; if (performance.now() - t0 < 400) requestAnimationFrame(c); else res(n); })();
  });
  g._pause();
  await new Promise(f => setTimeout(f, 200));
  const menu = document.getElementById('menu');
  const style = getComputedStyle(menu);
  const drawnWhilePaused = await frames();
  const out = {
    menuShown: !menu.classList.contains('hidden'),
    isOverlay: menu.classList.contains('overlay'),
    bodyPaused: document.body.classList.contains('paused'),
    blurred: style.backdropFilter !== 'none' && style.backdropFilter !== '',
    seeThrough: !/^rgb\(/.test(style.backgroundColor),
    stillRendering: drawnWhilePaused > 8,
    pointerFree: document.pointerLockElement === null,
    worldStillMoving: false
  };
  const before = g.player.pos.y;
  g.player.pos.y += 4;
  await new Promise(f => setTimeout(f, 500));
  out.worldStillMoving = Math.abs(g.player.pos.y - (before + 4)) > 0.2;
  return out;
});

// the menu's own settings button is the way back in when the key is unbound
await page.click('#menusettings');
await page.waitForTimeout(250);
R.menuButtonOpensSettings = await page.isVisible('#editpanel');
R.menuClosedBehindIt = await page.evaluate(() =>
  document.getElementById('menu').classList.contains('hidden'));
await close();

// -------------------------------------------------------------------- verdict
if (!R.equalsDoesNothing) fail.push('= still opens the settings panel, and it should not');
if (String(R.forwardKeys) !== 'W') fail.push('Forward does not show W: ' + R.forwardKeys);
if (String(R.sprintKeys) !== 'Shift L,Shift R') fail.push('Sprint does not show both shifts as two keys: ' + R.sprintKeys);
if (String(R.settingsKeys) !== '`') fail.push('Open settings is not bound to `: ' + R.settingsKeys);
if (String(R.menuKeys) !== 'Esc') fail.push('Open menu is not bound to Esc: ' + R.menuKeys);
if (R.arming !== 'fwd') fail.push('clicking a key did not arm its row');
if (String(R.afterRebind) !== 'I') fail.push('rebinding did not replace the key: ' + R.afterRebind);
if (R.savedBinds !== 'fwd') fail.push('the rebind was not saved');
if (!(R.rebindWorks.withI < -0.5)) fail.push('the rebound key does not move the player: ' + JSON.stringify(R.rebindWorks));
if (Math.abs(R.rebindWorks.withW) > 0.1) fail.push('the old key still moves the player: ' + JSON.stringify(R.rebindWorks));
if (String(R.afterAdd) !== 'I,O') fail.push('+ did not add a second key: ' + R.afterAdd);
if (!(R.bothKeysWork.withI < -0.5) || !(R.bothKeysWork.withO < -0.5)) fail.push('both keys do not move the player: ' + JSON.stringify(R.bothKeysWork));
if (String(R.afterRemove) !== 'O') fail.push('Backspace did not remove just the one key: ' + R.afterRemove);
if (Math.abs(R.afterRemoveWorks.withI) > 0.1) fail.push('the removed key still moves the player');
if (!(R.afterRemoveWorks.withO < -0.5)) fail.push('removing one key killed the other');
if (R.survivedReload !== 'fwd') fail.push('the rebind did not survive a reload');
if (!R.newSettingsKeyCloses || !R.newSettingsKeyOpens) fail.push('the rebound settings key does not work');
if (!R.oldSettingsKeyDead) fail.push('` still opens the panel after Open settings was rebound');
if (R.afterReset.w !== 'fwd' || !R.afterReset.oGone || !R.afterReset.uGone) fail.push('RESET KEYS did not restore the defaults: ' + JSON.stringify(R.afterReset));
if (R.afterReset.settings !== 'settings' || R.afterReset.menu !== 'menu') fail.push('RESET KEYS lost the settings/menu bindings');
if (String(R.forwardAfterReset) !== 'W') fail.push('RESET KEYS did not repaint the rows');
if (!R.sprintLatches.afterTap) fail.push('sprint did not latch on');
if (R.sprintLatches.afterSecondTap) fail.push('sprint did not latch off');
if (!R.jumpLatches.held) fail.push('jump did not latch on');
if (R.jumpLatches.hops < 2) fail.push('a latched jump did not keep hopping: ' + JSON.stringify(R.jumpLatches));
if (!R.jumpLatches.releasedOnSecondTap) fail.push('jump did not latch off');
if (!R.sprintButton.exists) fail.push('there is no sprint button');
if (!R.sprintButton.inTouchPad) fail.push('the sprint button is not on the touch pad');
if (!R.sprintButton.whileDown) fail.push('the sprint button does not press sprint');
if (R.sprintButton.afterUp) fail.push('the sprint button stayed down after release');
if (!R.protection.shieldedWhileEditing || !R.protection.damageIgnored) fail.push('the editing shield does not block damage');
if (Math.abs(R.protection.protectedFor - 3) > 0.3) fail.push('protection is not 3s: ' + R.protection.protectedFor);
if (!R.protection.stillShielded || !R.protection.damageStillIgnored) fail.push('damage got through the tail of the shield');
if (R.protection.firedWhileProtected) fail.push('the gun fired while still shielded — the two are meant to be one state');
if (!R.protection.hasOnlyOneTimer) fail.push('there is still a second timer: ' + JSON.stringify(R.protection));
if (R.protectionGone.shielded || !R.protectionGone.timerPassed) fail.push('protection outlasted 3s: ' + JSON.stringify(R.protectionGone));
if (!R.protectionGone.firedAfterwards) fail.push('the gun never came back after protection ended: ' + JSON.stringify(R.protectionGone));
if (!R.pause.menuShown || !R.pause.isOverlay || !R.pause.bodyPaused) fail.push('pause did not open as an overlay');
if (!R.pause.blurred) fail.push('the paused view is not blurred');
if (!R.pause.seeThrough) fail.push('the pause screen is opaque, so the game is not behind it');
if (!R.pause.stillRendering) fail.push('the game stopped rendering while paused');
if (!R.pause.pointerFree) fail.push('the mouse is still captured on the pause screen');
if (!R.pause.worldStillMoving) fail.push('the world froze while paused');
if (!R.menuButtonOpensSettings) fail.push('the menu SETTINGS button does not open the panel');
if (!R.menuClosedBehindIt) fail.push('the menu stayed up behind the settings panel');
if (R.designRowsPresent.length !== 13) fail.push('the designer key list is wrong: ' + R.designRowsPresent);
if (!R.designSectionHiddenInAMatch) fail.push('the designer key section shows during a match');
if (R.designDefaults.del !== 'ddelete') fail.push('T does not delete in the designer');
if (R.designDefaults.rotate !== 'rotate') fail.push('R does not rotate in the designer');
if (R.designDefaults.shape !== 'shape') fail.push('F does not switch shape in the designer');
if (R.designDefaults.matchR !== 'reload' || R.designDefaults.matchQ !== 'lastweapon') fail.push('the designer map leaked into the match map');
if (errs.length) fail.push('page errors: ' + errs.join(' | '));

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
if (fail.length) { console.log('FAIL: ' + fail.join('\n      ')); await browser.close(); process.exit(1); }
console.log('PASS — keys rebind, stack and clear; four actions latch; one 3s protection window; pause floats over the game');
await browser.close();
