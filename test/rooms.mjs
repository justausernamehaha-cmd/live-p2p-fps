// Joining a room, versus making one.
//
// There is no server, so "does this room already exist" cannot be asked — it can
// only be listened for. Pressing CONNECT opens the room and waits: an empty one
// is yours to make, with your code and your seed; one with somebody in it
// already has a level, and a joiner's seed has no business overwriting it.
//
// Two real pages, finding each other over the real relays, because that is the
// only thing that proves the scan means anything. The negative control is the
// first page: it must decide the room is *new*, or the second page's answer is
// not worth anything.
//
//   ./serve.sh 8080 &   then   node test/rooms.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 800, height: 520 } });
const room = 'rooms-' + Date.now();
const errs = [];

const open = async (name) => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(name + ': ' + e.message));
  await p.goto(URL);
  await p.waitForFunction(() => window.__paStarted, { timeout: 25000 });
  await p.fill('#nameinput', name);
  await p.fill('#roominput', room);
  return p;
};

const A = await open('alpha');
const B = await open('beta');

// Two different levels, so "whose seed won" is answerable. Both are real seeds
// built by the level code itself rather than typed by hand.
const seedFor = (page, w, l) => page.evaluate(([w, l]) => {
  const lvl = new window.__Level(w, l, 12);
  // `c` is the colour index the seed stores, not a hex colour
  lvl.boxes.push({ x0: -3, y0: 0, z0: -3, x1: 3, y1: 2, z1: 3, c: 1, shape: 0, rx: 0, ry: 0, rz: 0 });
  return lvl.encode();
}, [w, l]);

const R = { room };
R.seedA = await seedFor(A, 44, 44);
R.seedB = await seedFor(B, 88, 88);
if (R.seedA === R.seedB) throw new Error('the two test seeds are identical; the test cannot tell them apart');

// ------------------------------------------------------------- A makes the room
await A.evaluate(s => { document.getElementById('seedinput').value = s; }, R.seedA);
await A.evaluate(() => document.getElementById('playbtn').click());
await A.waitForFunction(() => window.game.running, { timeout: 30000 });
R.aJoinedExisting = await A.evaluate(() => window.game.joinedExisting);
R.aLevel = await A.evaluate(() => window.game.world.level && [window.game.world.level.w, window.game.world.level.l]);
R.aSeedKept = await A.evaluate(() => window.game.seed);

// -------------------------------------------------------------- B joins it
await B.evaluate(s => { document.getElementById('seedinput').value = s; }, R.seedB);
const sawJoining = B.waitForFunction(
  () => document.getElementById('jtitle').textContent.toLowerCase().includes('joining'),
  { timeout: 30000 }).then(() => true).catch(() => false);
await B.evaluate(() => document.getElementById('playbtn').click());
R.bSawJoiningScreen = await sawJoining;
await B.waitForFunction(() => window.game.running, { timeout: 40000 });
R.bJoinedExisting = await B.evaluate(() => window.game.joinedExisting);
R.bLevel = await B.evaluate(() => window.game.world.level && [window.game.world.level.w, window.game.world.level.l]);
R.bSeed = await B.evaluate(() => window.game.seed);
R.bTookTheRoomsSeed = R.bSeed === R.seedA;
R.bDiscardedItsOwn = R.bSeed !== R.seedB;

// the three-second shield, and the gun locked for exactly as long
R.bShieldedOnArrival = await B.evaluate(() => window.game.shielded);
R.bGunLocked = await B.evaluate(async () => {
  const g = window.game;
  const before = g.portals ? g.loadout.ammo.mag : 0;
  g.input.held.add('fire');
  await new Promise(f => setTimeout(f, 400));
  const after = g.loadout.ammo.mag;
  g.input.held.delete('fire');
  return after === before;
});
await B.waitForTimeout(3200);
R.bShieldGoneAfter3s = await B.evaluate(() => !window.game.shielded);

// ------------------------------------------------------------ and leaving again
await B.evaluate(() => document.getElementById('exitbtn').click());
await B.waitForTimeout(400);
R.bLeft = await B.evaluate(() => ({
  running: window.game.running,
  menuShown: !document.getElementById('menu').classList.contains('hidden'),
  hudHidden: document.getElementById('hud').classList.contains('hidden'),
  playBtn: document.getElementById('playbtn').textContent,
  exitHidden: document.getElementById('exitbtn').classList.contains('hidden')
}));

// ...and can come back in
await B.evaluate(() => document.getElementById('playbtn').click());
await B.waitForFunction(() => window.game.running, { timeout: 40000 });
R.bRejoined = await B.evaluate(() => window.game.running);

const fail = [];
if (R.aJoinedExisting) fail.push('the first page thought the room already existed');
if (R.aSeedKept !== R.seedA) fail.push('the room maker did not keep its own seed');
if (!R.bJoinedExisting) fail.push('the second page did not see the room as existing');
if (!R.bSawJoiningScreen) fail.push('no joining screen was shown');
if (!R.bTookTheRoomsSeed) fail.push('the joiner did not take the room\'s level');
if (!R.bDiscardedItsOwn) fail.push('the joiner kept its own seed instead of discarding it');
if (JSON.stringify(R.aLevel) !== JSON.stringify(R.bLevel))
  fail.push(`the two are not in the same level: ${JSON.stringify(R.aLevel)} vs ${JSON.stringify(R.bLevel)}`);
if (!R.bShieldedOnArrival) fail.push('the joiner arrived unshielded');
if (!R.bGunLocked) fail.push('the joiner could fire during the shield');
if (!R.bShieldGoneAfter3s) fail.push('the shield had not lifted after three seconds');
if (R.bLeft.running) fail.push('LEAVE THE ROOM did not stop the match');
if (!R.bLeft.menuShown) fail.push('LEAVE THE ROOM did not show the connect screen');
if (!R.bLeft.hudHidden) fail.push('LEAVE THE ROOM left the HUD up');
if (R.bLeft.playBtn !== 'CONNECT') fail.push('the button did not go back to CONNECT');
if (!R.bLeft.exitHidden) fail.push('the exit button is still there after leaving');
if (!R.bRejoined) fail.push('could not connect again after leaving');

console.log(JSON.stringify({ ...R, seedA: R.seedA.slice(0, 24) + '…', seedB: R.seedB.slice(0, 24) + '…',
                             bSeed: (R.bSeed || '').slice(0, 24) + '…' }, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ')
                        : 'PASS: an empty room is made, an existing one is joined behind a shield, and leaving works');
await browser.close();
process.exit(fail.length ? 1 : 0);
