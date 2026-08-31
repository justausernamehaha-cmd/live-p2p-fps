// Crouch and aim can each be set to hold or toggle, from the settings panel.
//
//   ./serve.sh 8080 &   then   node test/holdtoggle.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#roominput', 'ht-' + Date.now());
await page.fill('#nameinput', 'ht');
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1300);

const R = {};

// the panel opens on a keyboard with backtick, and both mode rows are there
await page.keyboard.press('Backquote');
await page.waitForTimeout(250);
R.panelOpen = await page.isVisible('#editpanel');
R.crouchRowVisible = await page.isVisible('.moderow[data-action=crouch]');
R.aimRowVisible = await page.isVisible('.moderow[data-action=ads]');
R.defaultsToHold = await page.evaluate(() =>
  [...document.querySelectorAll('.modes button[data-mode=hold]')].every(b => b.classList.contains('on')));

// The panel has to be shut to drive the game: input is deliberately suspended
// while it is open, which is why the first version of this test measured
// nothing at all.
const closePanel = async () => { await page.keyboard.press('Backquote'); await page.waitForTimeout(200); };
const openPanel = async () => { await page.keyboard.press('Backquote'); await page.waitForTimeout(200); };

const crouchTrial = () => page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const key = (type, code) => dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  g.player.crouchT = 0;
  key('keydown', 'KeyC'); await sleep(450);
  const whileDown = g.player.crouching;
  key('keyup', 'KeyC'); await sleep(450);
  const afterRelease = g.player.crouching;
  key('keydown', 'KeyC'); await sleep(60); key('keyup', 'KeyC'); await sleep(450);
  const afterSecondPress = g.player.crouching;
  return { whileDown, afterRelease, afterSecondPress };
});

await closePanel();
R.crouchAsHold = await crouchTrial();

// switch crouch to toggle through the actual UI
await openPanel();
await page.click('.modes button[data-action=crouch][data-mode=toggle]');
await page.waitForTimeout(150);
R.toggleButtonLitAfterClick = await page.evaluate(() =>
  document.querySelector('.modes button[data-action=crouch][data-mode=toggle]').classList.contains('on'));
R.savedToStorage = await page.evaluate(() => localStorage.getItem('pa.modes'));
await closePanel();
R.crouchAsToggle = await crouchTrial();

// aim, the same way, through the mouse
await openPanel();
await page.click('.modes button[data-action=ads][data-mode=toggle]');
await page.waitForTimeout(150);
await closePanel();
R.aimAsToggle = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const press = buttons => document.dispatchEvent(new MouseEvent('mousedown', { button: 2, buttons, bubbles: true }));
  const lift = buttons => document.dispatchEvent(new MouseEvent('mouseup', { button: 2, buttons, bubbles: true }));
  press(2); await sleep(60); lift(0); await sleep(500);
  const afterOnePressAndRelease = g.adsT;
  press(2); await sleep(60); lift(0); await sleep(500);
  const afterSecond = g.adsT;
  return { afterOnePressAndRelease: +afterOnePressAndRelease.toFixed(2), afterSecond: +afterSecond.toFixed(2) };
});

// switching back to hold must not leave the action stuck on
await page.evaluate(async () => {
  const g = window.game;
  document.dispatchEvent(new MouseEvent('mousedown', { button: 2, buttons: 2, bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { button: 2, buttons: 0, bubbles: true }));
  await new Promise(f => setTimeout(f, 100));
});
R.aimLatchedBeforeSwitch = await page.evaluate(() => window.game.input.down('ads'));
await openPanel();
await page.click('.modes button[data-action=ads][data-mode=hold]');
await page.waitForTimeout(150);
R.aimClearedOnSwitchBack = await page.evaluate(() => !window.game.input.down('ads'));

// and it survives a reload
await page.reload();
await page.waitForFunction(() => window.__paStarted);
R.crouchStillToggleAfterReload = await page.evaluate(() => window.game.input.isToggle('crouch'));

const fail = [];
if (!R.panelOpen || !R.crouchRowVisible || !R.aimRowVisible) fail.push('the mode rows are not in the panel');
if (!R.defaultsToHold) fail.push('hold is not the default');
if (!(R.crouchAsHold.whileDown && !R.crouchAsHold.afterRelease)) fail.push('hold mode does not hold');
if (!R.toggleButtonLitAfterClick) fail.push('the toggle button did not light up');
if (!(R.crouchAsToggle.whileDown && R.crouchAsToggle.afterRelease && !R.crouchAsToggle.afterSecondPress))
  fail.push('toggle mode does not latch and unlatch');
if (R.aimAsToggle.afterOnePressAndRelease !== 1) fail.push('aim did not latch on');
if (R.aimAsToggle.afterSecond !== 0) fail.push('aim did not latch off');
if (!R.aimClearedOnSwitchBack) fail.push('switching back to hold left the action stuck on');
if (!R.crouchStillToggleAfterReload) fail.push('the setting did not survive a reload');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: hold and toggle both behave, and persist');
await browser.close();
process.exit(fail.length ? 1 : 0);
