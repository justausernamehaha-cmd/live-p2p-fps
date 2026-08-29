// The level designer, driven the way a person drives it: room code, room size,
// fly, draw, colour, delete, playtest, export, reload.
//
// What this is really guarding is that the designer's output is a *level* —
// something a player can afterwards stand on. "A box appeared in the array" is a
// liveness check; every assertion here is against an independent source of
// truth: the world's own collision boxes, the player's feet height once the room
// is played, and a seed decoded in a fresh page that never saw the designer.
//
//   ./serve.sh 8080 &   then   node test/designer.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => page.waitForTimeout(ms);

await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);

const R = {};
const fail = [];

// ---------------------------------------------------------------- getting in
await page.fill('#nameinput', 'builder');
await page.fill('#roominput', 'level design');
await page.evaluate(() => document.getElementById('playbtn').click());
await sleep(300);
R.setupShown = await page.isVisible('#designsetup');
R.noNetwork = await page.evaluate(() => window.game.net === null);

await page.fill('#dw', '40');
await page.fill('#dl', '50');
await page.fill('#dh', '12');
await page.click('#dstart');
await sleep(500);

R.hudShown = await page.isVisible('#designhud');
R.inDesign = await page.evaluate(() => !!window.game.design);
R.stillNoNetwork = await page.evaluate(() => window.game.net === null);
R.roomDims = await page.evaluate(() => {
  const l = window.game.design.level;
  return [l.w, l.l, l.h];
});
// the shell is six boxes and the floor's top is y = 0, so a player stands where
// they do in the arena
R.shellCount = await page.evaluate(() => window.game.design.level.shell.length);
R.floorTop = await page.evaluate(() =>
  window.game.world.boxes.find(b => b.src?.kind === 'floor').max.y);

// ------------------------------------------------------- the ghost is boxed in
// Flying is checked against the camera's own forward vector, not against "it
// moved": looking up and pressing forward has to gain height.
R.flyUp = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  d.pos = { x: 0, y: 4, z: 0 };
  g.player.pitch = 0.8;                       // nose up
  g.player.yaw = 0;
  const before = { ...d.pos };
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  await sleep(300);
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  const dy = d.pos.y - before.y;
  const dz = d.pos.z - before.z;
  // forward at pitch 0.8 with yaw 0 is (0, sin .8, -cos .8): up and toward -z
  return { rose: dy > 0.5, wentForward: dz < -0.3, dy: +dy.toFixed(2), dz: +dz.toFixed(2) };
});

R.boxedIn = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  d.pos = { x: 0, y: 6, z: 0 };
  g.player.pitch = 0; g.player.yaw = 0;       // straight at -z, the 50 m wall
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  await sleep(2600);                          // far longer than it takes to cross
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  await sleep(60);
  const L = d.level;
  return {
    z: +d.pos.z.toFixed(2),
    insideRoom: d.pos.z > -L.l / 2 && d.pos.x > -L.w / 2 && d.pos.x < L.w / 2 &&
                d.pos.y > 0 && d.pos.y < L.h
  };
});

// --------------------------------------------------- draw a rectangle on the floor
// Straight down at the floor, three clicks: start, base, height.
R.drawn = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const before = d.level.boxes.length;
  d.pos = { x: 0, y: 8, z: 0 };
  g.player.pitch = -Math.PI / 2 + 0.02;       // all but straight down
  g.player.yaw = 0;
  d.snap = true;
  await sleep(80);
  const click = () => d._click();
  // the real loop is _camera() then _tools(); poking yaw/pitch and calling
  // _tools() alone would aim with the previous frame's camera
  const aim = (pitch, yaw) => { g.player.pitch = pitch; g.player.yaw = yaw; d._camera(); d._tools(); };

  aim(-Math.PI / 2 + 0.02, 0);
  click();                                     // pick the floor surface
  const stageAfterFirst = d.stage;
  const surfaceAxis = d.surface && d.surface.axis;
  const surfacePlane = d.surface && d.surface.plane;

  // drag the far corner by looking somewhere else on the same surface
  aim(-1.1, 0.35);
  const b = { ...d.b };
  click();                                     // fix the base
  const stageAfterSecond = d.stage;

  // pull a height by tilting back up, then commit
  aim(-0.55, 0.35);
  const pull = d.pull;
  click();
  return {
    stageAfterFirst, stageAfterSecond, surfaceAxis, surfacePlane,
    pull: +pull.toFixed(2),
    grew: d.level.boxes.length - before,
    idle: d.stage === 'idle',
    // a rectangle, not a pinprick: the second point really did travel
    footprint: [+(Math.abs(b.x - d.a.x)).toFixed(2), +(Math.abs(b.z - d.a.z)).toFixed(2)],
    a: d.a, b
  };
});

// the box the designer made is a box the *world* knows about
R.inWorld = await page.evaluate(() => {
  const g = window.game;
  const made = g.design.level.boxes[g.design.level.boxes.length - 1];
  const hit = g.world.boxes.find(w => w.src === made);
  return !!hit && hit.max.y > hit.min.y && hit.max.x > hit.min.x && hit.max.z > hit.min.z;
});
R.snapped = await page.evaluate(() => {
  const b = window.game.design.level.boxes.at(-1);
  const on = v => Math.abs(v / 0.5 - Math.round(v / 0.5)) < 1e-6;
  return [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1].every(on);
});

// --------------------------------------------------------- a negative pull sinks in
R.negativePull = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const aim = (pitch, yaw) => { g.player.pitch = pitch; g.player.yaw = yaw; d._camera(); d._tools(); };
  d.pos = { x: 14, y: 8, z: 14 };
  aim(-Math.PI / 2 + 0.02, 0); d._click();
  aim(-1.2, 0.4); d._click();
  d.pull = -2;                                 // as if the mouse pulled it inward
  d._commitRect();
  const made = d.level.boxes.at(-1);
  // the floor's top is y = 0, so sinking in means the box lives below it
  return { y0: made.y0, y1: made.y1, sank: made.y0 < 0 && made.y1 <= 0.001 };
});

// ---------------------------------------------------------- Q / E floating box
R.floating = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const before = d.level.boxes.length;
  d.pos = { x: -6, y: 5, z: 0 };
  g.player.pitch = 0; g.player.yaw = 0;
  d._camera(); d._tools();
  const cornerOne = { ...d.reachPoint };
  d._corner('q');
  const marked = !!d.cornerA;
  d.pos = { x: -2, y: 8, z: -4 };
  d._camera(); d._tools();
  const cornerTwo = { ...d.reachPoint };
  d._corner('e');
  const made = d.level.boxes.at(-1);
  return {
    marked, grew: d.level.boxes.length - before, cleared: d.cornerA === null,
    // the corners are the reach point, three metres ahead of the eye, not the eye
    spansCorners: made.x0 <= Math.min(cornerOne.x, cornerTwo.x) + 1e-6 &&
                  made.x1 >= Math.max(cornerOne.x, cornerTwo.x) - 1e-6 &&
                  made.y1 > made.y0 && made.z1 > made.z0,
    aheadOfEye: Math.abs(cornerOne.z - 0) > 2      // the eye was at z = 0
  };
});

// -------------------------------------------------- select, colour and delete
R.editing = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const key = code => dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  const target = d.level.boxes.at(-1);
  d.selected = target;
  key('Digit6');                               // 6 -> index 5, red
  const colouredTo = target.c;
  const worldColour = g.world.boxes.find(w => w.src === target)?.color;

  key('Digit0');                               // 0 is the tenth colour, not a reset
  const zeroIsTenth = target.c === 9;

  const n = d.level.boxes.length;
  key('KeyT');                                 // delete moved off R, which now turns things
  const deleted = d.level.boxes.length === n - 1;
  const goneFromWorld = !g.world.boxes.some(w => w.src === target);

  // the shell is selectable and colourable, but it cannot be deleted
  const floor = d.level.shell[0];
  d.selected = floor;
  key('Digit3');
  const floorColoured = floor.c === 2;
  const before = d.level.shell.length;
  key('KeyT');
  return {
    colouredTo, worldColour, zeroIsTenth, deleted, goneFromWorld, floorColoured,
    floorSurvived: d.level.shell.length === before && d.level.shell.includes(floor),
    // and the level itself refuses, not only the key handler above it
    removeRefusedByLevel: d.level.remove(floor) === false && d.level.shell.includes(floor)
  };
});

// ------------------------------------------------------------------ playtest
R.playtest = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  // a wide plate to land on, so "the player stands on what was built" is testable
  d.level.add({ x: -18, y: 0, z: -22 }, { x: -10, y: 3, z: -14 }, 1);
  d._changed();
  d.pos = { x: -14, y: 9, z: -18 };
  d.togglePlay();
  const nowPlaying = !d.ghost;
  await sleep(1400);                           // fall onto the plate
  const feet = g.player.pos.y;
  const alive = g.player.alive;
  d.togglePlay();
  return {
    nowPlaying, backToGhost: d.ghost, alive,
    feet: +feet.toFixed(2),
    landedOnTheBuiltBox: Math.abs(feet - 3) < 0.15
  };
});

// -------------------------------------------------------- Tab is not the scoreboard
R.tabPlaytests = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const wasGhost = d.ghost;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
  await new Promise(f => setTimeout(f, 250));
  const flipped = d.ghost !== wasGhost;
  const scoreboardHidden = document.getElementById('scoreboard').classList.contains('hidden');
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', bubbles: true }));
  await new Promise(f => setTimeout(f, 250));
  return { flipped, scoreboardHidden, backAgain: d.ghost === wasGhost };
});

// ------------------------------------------------------------ Alt frees the mouse
R.altFreesMouse = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const menuBefore = !document.getElementById('menu').classList.contains('hidden');
  dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft', bubbles: true }));
  await new Promise(f => setTimeout(f, 120));
  const free = d.mouseFree, suspended = g.input.suspendLock;
  // losing the pointer this way must NOT be read as Escape and throw the menu up
  g.input.onAction?.('pause');
  const menuAfter = !document.getElementById('menu').classList.contains('hidden');
  dispatchEvent(new KeyboardEvent('keyup', { code: 'AltLeft', bubbles: true }));
  await new Promise(f => setTimeout(f, 120));
  return { free, suspended, menuBefore, menuAfter, released: !d.mouseFree,
           lockUnsuspended: !g.input.suspendLock };
});

// ------------------------------------------------------------- seed round trip
R.seed = await page.evaluate(() => {
  const d = window.game.design;
  const seed = d.level.encode();
  document.getElementById('dseed').value = seed;
  return { seed, boxes: d.level.boxes.length, dims: [d.level.w, d.level.l, d.level.h] };
});
R.seedRejectsDamage = await page.evaluate(() => {
  const seed = window.game.design.level.encode();
  // drop a character out of the middle, the way a bad copy-paste would
  const cut = seed.slice(0, Math.floor(seed.length / 2)) + seed.slice(Math.floor(seed.length / 2) + 1);
  try { window.__Level.decode(cut); return { threw: false, message: '' }; }
  catch (e) { return { threw: true, message: e.message }; }
});

// A seed is only worth anything if a page that never met the designer can play
// it. Load it in a fresh tab, as a room seed, and stand on the level.
const page2 = await ctx.newPage();
const errs2 = [];
page2.on('pageerror', e => errs2.push(e.message));
await page2.goto(URL);
await page2.waitForFunction(() => window.__paStarted);
await page2.fill('#nameinput', 'player');
await page2.fill('#roominput', 'seeded-' + Date.now());
// the seed box lives in a collapsed <details> until there is a seed to show
R.seedBoxCollapsedByDefault = await page2.evaluate(() => !document.getElementById('seedwrap').open);
await page2.evaluate(() => { document.getElementById('seedwrap').open = true; });
await page2.fill('#seedinput', R.seed.seed);
await page2.evaluate(() => document.getElementById('playbtn').click());
await page2.waitForTimeout(2500);

R.seeded = await page2.evaluate(async () => {
  const g = window.game;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const L = g.world.level;
  if (!L) return { loaded: false };
  // stand on the 8x8x3 plate the designer put at the origin
  g.player.spawn({ x: -14, y: 8, z: -18 });
  await sleep(1500);
  return {
    loaded: true,
    dims: [L.w, L.l, L.h],
    boxes: L.boxes.length,
    feet: +g.player.pos.y.toFixed(2),
    onThePlate: Math.abs(g.player.pos.y - 3) < 0.15,
    // a level is not a level without somewhere to start
    spawns: g.world.spawns.length,
    spawnsInside: g.world.spawns.every(s =>
      Math.abs(s.x) < L.w / 2 && Math.abs(s.z) < L.l / 2 && s.y >= 0 && s.y < L.h)
  };
});

R.badSeedRefused = await page2.evaluate(async () => {
  const g = window.game;
  g.running = false;                       // back to a cold connect screen
  document.getElementById('seedinput').value = 'PA1-not-a-real-seed-nope-zz';
  document.getElementById('playbtn').click();
  await new Promise(f => setTimeout(f, 200));
  return {
    message: document.getElementById('status').textContent,
    didNotConnect: g.running === false
  };
});

// ------------------------------------------------------------------- verdict
if (!R.setupShown) fail.push('the room-size panel did not open');
if (!R.noNetwork || !R.stillNoNetwork) fail.push('a design room opened a network connection');
if (!R.inDesign) fail.push('the designer did not start');
if (String(R.roomDims) !== '40,50,12') fail.push('room size was not honoured: ' + R.roomDims);
if (R.shellCount !== 6) fail.push('the shell is not six pieces');
if (R.floorTop !== 0) fail.push('the floor top is not y=0, so nothing stands where it should');
if (!R.flyUp.rose || !R.flyUp.wentForward) fail.push('forward did not follow the look direction: ' + JSON.stringify(R.flyUp));
if (!R.boxedIn.insideRoom) fail.push('the ghost left the room: ' + JSON.stringify(R.boxedIn));
if (R.drawn.stageAfterFirst !== 'rect') fail.push('the first click did not start a rectangle');
if (R.drawn.stageAfterSecond !== 'height') fail.push('the second click did not fix the base');
if (R.drawn.surfaceAxis !== 1 || R.drawn.surfacePlane !== 0) fail.push('the floor was not the surface picked: ' + JSON.stringify(R.drawn));
if (R.drawn.grew !== 1 || !R.drawn.idle) fail.push('the third click did not finish the box');
if (R.drawn.footprint[0] < 0.5 || R.drawn.footprint[1] < 1) fail.push('the second point never left the first: ' + JSON.stringify(R.drawn));
if (!(R.drawn.pull > 0.5)) fail.push('no height was pulled: ' + R.drawn.pull);
if (!R.inWorld) fail.push('the drawn box never reached the world collision list');
if (!R.snapped) fail.push('a snapped box came out off the grid');
if (!R.negativePull.sank) fail.push('a negative pull did not sink the box in: ' + JSON.stringify(R.negativePull));
if (!R.floating.marked || R.floating.grew !== 1 || !R.floating.cleared) fail.push('Q/E did not make a box: ' + JSON.stringify(R.floating));
if (!R.floating.spansCorners) fail.push('the Q/E box does not span the two corners');
if (!R.floating.aheadOfEye) fail.push('the Q/E corner was the eye, not the reach point');
if (R.editing.colouredTo !== 5) fail.push('6 did not set the sixth colour');
if (R.editing.worldColour !== 0xc7443f) fail.push('the colour never reached the mesh');
if (!R.editing.zeroIsTenth) fail.push('0 is not the tenth colour');
if (!R.editing.deleted || !R.editing.goneFromWorld) fail.push('T did not delete the selection');
if (!R.editing.floorColoured) fail.push('the floor could not be coloured');
if (!R.editing.floorSurvived) fail.push('the floor was deleted, and it must not be');
if (!R.editing.removeRefusedByLevel) fail.push('Level.remove will delete the floor if anything asks it to');
if (!R.playtest.nowPlaying || !R.playtest.backToGhost) fail.push('playtest did not toggle');
if (!R.playtest.landedOnTheBuiltBox) fail.push('the playtest player did not stand on the built box: ' + JSON.stringify(R.playtest));
if (!R.tabPlaytests.flipped || !R.tabPlaytests.backAgain) fail.push('Tab did not switch modes');
if (!R.tabPlaytests.scoreboardHidden) fail.push('Tab opened the scoreboard in a design room');
if (!R.altFreesMouse.free || !R.altFreesMouse.suspended) fail.push('Alt did not free the mouse');
if (R.altFreesMouse.menuAfter) fail.push('freeing the mouse with Alt threw the pause menu up');
if (!R.altFreesMouse.released || !R.altFreesMouse.lockUnsuspended) fail.push('letting Alt go did not take the mouse back');
if (!R.seedRejectsDamage.threw) fail.push('a damaged seed was accepted');
if (!R.seeded.loaded) fail.push('the seed did not load in a fresh page');
if (String(R.seeded.dims) !== '40,50,12') fail.push('the seed lost the room size: ' + R.seeded.dims);
if (R.seeded.boxes !== R.seed.boxes) fail.push(`the seed lost boxes: ${R.seed.boxes} -> ${R.seeded.boxes}`);
if (!R.seeded.onThePlate) fail.push('a fresh page could not stand on the designed level: ' + JSON.stringify(R.seeded));
if (R.seeded.spawns !== 8 || !R.seeded.spawnsInside) fail.push('the designed level has no usable spawns');
if (!R.badSeedRefused.didNotConnect || !R.badSeedRefused.message) fail.push('a bad seed connected anyway');
if (errs.length || errs2.length) fail.push('page errors: ' + [...errs, ...errs2].join(' | '));

console.log(JSON.stringify({ ...R, seed: { ...R.seed, seed: R.seed.seed.slice(0, 60) + '…' } }, null, 2));
console.log('page errors:', errs.length + errs2.length ? [...errs, ...errs2] : 'none');
if (fail.length) { console.log('FAIL: ' + fail.join('\n      ')); await browser.close(); process.exit(1); }
console.log('PASS — the designer builds a level, and a page that never saw it can play that level');
await browser.close();
