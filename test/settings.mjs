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
// 17 rows since the portal gun arrived and brought a Weapon 4 with it
await must(R.rows.length === 17, 'expected 17 key rows, got ' + R.rows.length);
R.weapon4Keys = await keysOf('Weapon 4 (portal gun)');
await must(R.weapon4Keys.length >= 1, 'the portal gun has no key: ' + JSON.stringify(R.weapon4Keys));
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
  // T moves things now and Delete deletes them, since a platform needs a key and
  // "the key called Delete deletes" beats anything else that was free
  platform: window.game.input.designAction('KeyT'),
  del: window.game.input.designAction('Delete'),
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

// ------------------------------------ the portal gun's two triggers, on a phone
// The portal gun has no fire and no aim: it has a left mouth and a right one. On
// a phone those are the FIRE and AIM buttons, so with it in hand they have to
// say so and wear the pair this page actually got — and AIM has to stop latching
// while they do, or a player who prefers a toggled aim would place a portal on
// the tap that turns it on and nothing at all on the tap that turns it off.
R.portalButtons = await page.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const fireBtn = document.querySelector('.tbtn[data-btn=fire]');
  const aimBtn = document.querySelector('.tbtn[data-btn=ads]');
  const t = () => performance.now() / 1000;
  // the labels are two lines, so the break counts as the space
  const text = el => el.innerHTML.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();

  g.input.setToggleMode('ads', true);          // the case that used to break
  g.protectedUntil = 0;
  g.player.alive = true;
  g._switch(g.loadout.switchTo(0, t()));       // rifle first
  await sleep(60);
  const asRifle = { fire: text(fireBtn), aim: text(aimBtn),
                    marked: fireBtn.classList.contains('portal') };

  g._switch(g.loadout.switchTo(3, t()));       // ...then the portal gun
  await sleep(60);
  const colours = g.portals.myColors();
  const hex = v => '#' + v.toString(16).padStart(6, '0');
  const asPortalGun = {
    fire: text(fireBtn), aim: text(aimBtn),
    marked: fireBtn.classList.contains('portal') && aimBtn.classList.contains('portal'),
    leftColour: fireBtn.style.getPropertyValue('--pc') === hex(colours.a),
    rightColour: aimBtn.style.getPropertyValue('--pc') === hex(colours.b),
    latches: g.input.isToggle('ads') && g.input.holdOverride.has('ads')
  };

  // tap AIM twice, the way a thumb does, and count the portal balls that leave
  let balls = 0;
  const realFire = g.portals.fire.bind(g.portals);
  g.portals.fire = function (...a) { if (!a[4]) balls++; return realFire(...a); };
  const tap = async el => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 7 }));
    await sleep(70);
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 7 }));
    await sleep(380);          // the gun's own interval is 0.32 s
  };
  await sleep(320);            // clear the quarter-second delay on swapping guns
  await tap(aimBtn);
  const afterOne = balls;
  const stuckOn = g.input.down('ads');
  await tap(aimBtn);
  const afterTwo = balls;
  await tap(fireBtn);
  const afterFire = balls;
  g.portals.fire = realFire;

  g._switch(g.loadout.switchTo(0, t()));       // back to the rifle
  await sleep(60);
  const restored = { fire: text(fireBtn), aim: text(aimBtn),
                     marked: fireBtn.classList.contains('portal'),
                     latchesAgain: !g.input.holdOverride.has('ads') };
  g.input.setToggleMode('ads', false);
  return { asRifle, asPortalGun, afterOne, afterTwo, afterFire, stuckOn, restored };
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
  out.liftedFrom = +before.toFixed(2);
  out.landedAt = +g.player.pos.y.toFixed(2);
  out.alive = g.player.alive;
  out.pos = { x: +g.player.pos.x.toFixed(1), z: +g.player.pos.z.toFixed(1) };
  return out;
});

// the menu's own settings button is the way back in when the key is unbound
await page.click('#menusettings');
await page.waitForTimeout(250);
R.menuButtonOpensSettings = await page.isVisible('#editpanel');
R.menuClosedBehindIt = await page.evaluate(() =>
  document.getElementById('menu').classList.contains('hidden'));
// The panel exists to be clicked, so it must arrive with the mouse free. Going
// through the menu used to ask for the pointer back on the way out of the pause
// screen and release it a millisecond later, and the lock could win that race.
R.settingsFreesTheMouse = await page.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const before = document.pointerLockElement !== null;
  // a click on the canvas must not quietly take it back either
  g.canvas.dispatchEvent(new PointerEvent('pointerdown',
    { pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true }));
  await sleep(250);
  return { locked: before, lockedAfterClick: document.pointerLockElement !== null,
           suspended: g.input.suspendLock };
});
await close();
R.lockAllowedAgainAfterwards = await page.evaluate(() => window.game.input.suspendLock === false);

// ------------------------------------------- the browser's own shortcuts
// Ctrl+W cannot be stopped by preventDefault(); only the Keyboard Lock API can,
// and only in element fullscreen. Both have to be asked for from a live user
// gesture — from a pointerlockchange handler the fullscreen request is rejected
// outright, which is how Ctrl+W went on closing the tab while the game believed
// it had the keyboard. The click that captures the mouse is the gesture.
R.keyboardLock = await page.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  g.input.keyboardLocked = false;
  await sleep(150);
  const before = { fullscreen: !!document.fullscreenElement, blocked: g.input.shortcutsBlocked };
  return { before, api: !!navigator.keyboard?.lock };
});
await page.mouse.click(450, 300);          // a real click, with a real gesture
await page.waitForTimeout(700);
R.keyboardLock.after = await page.evaluate(() => ({
  fullscreen: !!document.fullscreenElement,
  keyboardLocked: window.game.input.keyboardLocked,
  blocked: window.game.input.shortcutsBlocked,
  label: document.getElementById('kblockval').textContent
}));
// and turning it off hands them back
R.keyboardLock.off = await page.evaluate(() => {
  window.game.input.setFullscreenLock(false);
  const r = { blocked: window.game.input.shortcutsBlocked };
  window.game.input.setFullscreenLock(true);
  return r;
});
await page.evaluate(() => document.exitFullscreen?.().catch(() => {}));
await page.waitForTimeout(200);

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
const PB = R.portalButtons;
if (PB.asRifle.fire !== 'FIRE' || PB.asRifle.aim !== 'AIM' || PB.asRifle.marked)
  fail.push('the ordinary buttons are not FIRE and AIM: ' + JSON.stringify(PB.asRifle));
if (PB.asPortalGun.fire !== 'LEFT PORTAL' || PB.asPortalGun.aim !== 'RIGHT PORTAL')
  fail.push('the portal gun does not rename its two triggers: ' + JSON.stringify(PB.asPortalGun));
if (!PB.asPortalGun.marked || !PB.asPortalGun.leftColour || !PB.asPortalGun.rightColour)
  fail.push('the triggers do not wear the page\'s own pair: ' + JSON.stringify(PB.asPortalGun));
if (!PB.asPortalGun.latches)
  fail.push('a latched AIM was not suspended for the portal gun: ' + JSON.stringify(PB.asPortalGun));
if (PB.afterOne !== 1) fail.push('the AIM button placed no right portal: ' + PB.afterOne);
if (PB.afterTwo !== 2) fail.push('the second AIM tap did nothing — the latch is still on: ' + JSON.stringify(PB));
if (PB.afterFire !== 3) fail.push('the FIRE button placed no left portal: ' + JSON.stringify(PB));
if (PB.stuckOn) fail.push('tapping AIM with the portal gun left the sights latched on');
if (PB.restored.fire !== 'FIRE' || PB.restored.aim !== 'AIM' || PB.restored.marked)
  fail.push('the buttons did not go back to FIRE and AIM: ' + JSON.stringify(PB.restored));
if (!PB.restored.latchesAgain) fail.push('AIM did not get its latch back with an ordinary gun');
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
if (R.settingsFreesTheMouse.locked) fail.push('opening settings from the menu left the mouse captured');
if (R.settingsFreesTheMouse.lockedAfterClick) fail.push('a click took the mouse back while the settings panel was open');
if (!R.settingsFreesTheMouse.suspended) fail.push('the settings panel does not hold the pointer lock off');
if (!R.lockAllowedAgainAfterwards) fail.push('the pointer lock is still suspended after closing settings');
if (R.designRowsPresent.length !== 14) fail.push('the designer key list is wrong: ' + R.designRowsPresent);
if (!R.designSectionHiddenInAMatch) fail.push('the designer key section shows during a match');
if (R.designDefaults.del !== 'ddelete') fail.push('Delete does not delete in the designer');
if (R.designDefaults.platform !== 'platform') fail.push('T does not make a moving platform: ' + R.designDefaults.platform);
if (R.designDefaults.rotate !== 'rotate') fail.push('R does not rotate in the designer');
if (R.designDefaults.shape !== 'shape') fail.push('F does not switch shape in the designer');
if (R.designDefaults.matchR !== 'reload' || R.designDefaults.matchQ !== 'lastweapon') fail.push('the designer map leaked into the match map');
if (R.keyboardLock.api) {
  if (!R.keyboardLock.after.fullscreen) fail.push('clicking the game did not take it fullscreen, so the keyboard cannot be locked: ' + JSON.stringify(R.keyboardLock));
  if (!R.keyboardLock.after.keyboardLocked) fail.push('navigator.keyboard.lock() never took: ' + JSON.stringify(R.keyboardLock));
  if (!R.keyboardLock.after.blocked) fail.push('the browser still owns Ctrl+W: ' + JSON.stringify(R.keyboardLock));
  if (R.keyboardLock.after.label !== 'blocked') fail.push('the settings panel misreports the lock: ' + R.keyboardLock.after.label);
  if (R.keyboardLock.off.blocked) fail.push('turning the setting off did not hand the shortcuts back');
}
if (errs.length) fail.push('page errors: ' + errs.join(' | '));

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
if (fail.length) { console.log('FAIL: ' + fail.join('\n      ')); await browser.close(); process.exit(1); }
console.log('PASS — keys rebind, stack and clear; four actions latch; one 3s protection window; pause floats over the game');
await browser.close();
