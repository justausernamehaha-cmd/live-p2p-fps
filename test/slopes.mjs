// Ramps and rotation — the two things that stopped every solid in the world
// being an axis-aligned box.
//
// solid.js is unit-tested on its own in test/solid.mjs. This is the other half:
// that the geometry means something to the *player*. A ramp is proved by walking
// up it and arriving on the platform; a turned wall by being blocked along the
// axis it was turned onto and free along the one it left.
//
//   ./serve.sh 8080 &   then   node test/slopes.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'ramp');
await page.fill('#roominput', 'ramp-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1600);

const R = {};
const fail = [];
const must = async (ok, why) => {
  if (ok) return;
  console.log(JSON.stringify(R, null, 2));
  console.log('FAIL: ' + why);
  await browser.close();
  process.exit(1);
};

// ------------------------------------------ the arena's stairs became ramps
R.arena = await page.evaluate(() => {
  const g = window.game;
  return {
    solids: g.world.solids.length,
    // a flight of half-metre steps was eight boxes; a ramp is one solid
    ramps: g.world.solids.filter(s => s.shape === 1).length,
    // and nothing axis-aligned is left standing in the +x ramp's footprint,
    // which is where a flight of steps used to be
    boxesInTheRampsPlace: g.world.boxes.filter(b =>
      b.min.x < 19 && b.max.x > 14 && b.min.z < 6 && b.max.z > -6 &&
      b.max.y > 0.1 && b.min.y < 2.5).length
  };
});

// Every slope in the map is 45 degrees, fillets included: the walkable face of
// each is equally close to two axes, which is exactly what makes it able to hand
// a player from one to the other.
R.pitches = await page.evaluate(() => {
  const g = window.game;
  const out = [];
  for (const s of g.world.solids) {
    if (s.shape !== 1) continue;
    for (const pl of s.planes) {
      const flat = Math.hypot(pl.nx, pl.nz);
      if (flat < 1e-6 || Math.abs(pl.ny) < 1e-6) continue;   // not a sloped face
      out.push(+(Math.atan2(flat, Math.abs(pl.ny)) * 180 / Math.PI).toFixed(2));
    }
  }
  return out;
});
R.every45 = R.pitches.length > 0 && R.pitches.every(p => Math.abs(p - 45) < 0.01);

// ------------------------------------- a fillet is geometry, not a gravity switch
// The corners are filleted so there is a walkable surface between a wall and a
// floor at all — and so a portal has somewhere to go there. What a fillet must
// *not* do is turn you over: only a portal ever changes which way you fall, so a
// wall-walker who reaches one stays on the wall, and somebody walking into the
// same corner the right way up stays upright.
R.fillet = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const keys = (...on) => { g.input.held.clear(); for (const k of on) g.input.held.add(k); g.input._recalcKeys(); };
  const wallX = 59.5;                       // the +x wall's inner face
  // standing on that wall means up points back into the room
  g.player.spawn({ x: 0, y: 0.2, z: 0 });
  g.player.up = { x: -1, y: 0, z: 0 };
  g.player.pos = { x: wallX, y: 6, z: 0 };
  g.player.vel = { x: 0, y: 0, z: 0 };
  g.player.yaw = 0; g.player.pitch = 0;
  await sleep(300);
  const stoodOnTheWall = g.player.onGround && g.player.up.x === -1;
  // "forward" for them is along the wall; aim at the floor and walk
  const a = window.__frame.anglesIn(g.player.up, { x: 0, y: -1, z: 0 });
  g.player.yaw = a.yaw;
  keys('fwd');
  await sleep(2500);
  keys();
  await sleep(300);
  const out = {
    stoodOnTheWall,
    upAfter: { ...g.player.up },
    keptTheirWall: g.player.up.x === -1,
    walkedOnTheFillet: g.player.onGround,
    restingY: +g.player.pos.y.toFixed(2), restingX: +g.player.pos.x.toFixed(2)
  };
  // ...and the same corner, walked into the right way up, leaves you upright
  g.player.spawn({ x: wallX - 6, y: 0.2, z: 0 });
  g.player.up = { x: 0, y: 1, z: 0 };
  g.player.yaw = -Math.PI / 2;              // forward is +x, at the corner
  g.player.pitch = 0;
  keys('fwd');
  await sleep(2200);
  keys();
  out.upAtTheCorner = { ...g.player.up };
  out.stayedUprightOnTheWayIn = g.player.up.y === 1;
  return out;
});

// The centre platform's ramp on +x climbs from x=16.5 (ground) to x=14 (2.5 m),
// at 45 degrees like every other slope in the map.
// Walk up it and arrive on the platform — that is the whole point of the change.
R.walkUp = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn({ x: 21, y: 0.3, z: 0 });
  g.player.yaw = Math.PI / 2;          // forward is -x, straight at the ramp
  g.player.pitch = 0;
  await sleep(400);
  const startY = g.player.pos.y;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  const climb = [];
  for (let i = 0; i < 14; i++) {
    await sleep(200);
    climb.push(+g.player.pos.y.toFixed(2));
  }
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  await sleep(200);
  return {
    startY: +startY.toFixed(2), climb,
    endY: +g.player.pos.y.toFixed(2), endX: +g.player.pos.x.toFixed(2),
    onGround: g.player.onGround,
    // the platform top is 2.5; anything close to it means they got up
    reachedThePlatform: g.player.pos.y > 2.4 && g.player.pos.x < 14.5
  };
});

// standing still on a ramp must not slide you back down it
R.doesNotSlide = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.player.spawn({ x: 15.25, y: 3, z: 0 });    // halfway up, dropped on
  await sleep(700);
  const settled = { x: g.player.pos.x, y: g.player.pos.y };
  await sleep(1500);                            // stand there, no keys
  return {
    settledY: +settled.y.toFixed(2),
    driftX: +Math.abs(g.player.pos.x - settled.x).toFixed(3),
    driftY: +Math.abs(g.player.pos.y - settled.y).toFixed(3),
    onGround: g.player.onGround,
    // halfway up a 2.5 m ramp is about 1.25 m; the point is it is *on* it
    standingOnTheRamp: g.player.pos.y > 0.6 && g.player.pos.y < 2.4
  };
});

// a ramp is solid to a bullet, at the height its surface actually is
R.hitscan = await page.evaluate(() => {
  const g = window.game;
  const at = (y) => g.world.raycast({ x: 21, y, z: 0 }, { x: -1, y: 0, z: 0 }, 60);
  return {
    // the surface is 1 m up at x=15.5, so a shot at 1 m stops 5.5 m out
    lowShot: +at(1).toFixed(2),
    // higher up the ramp is thinner, so the shot gets further before it lands
    highShot: +at(2.2).toFixed(2),
    stoppedByTheRamp: at(1) > 2 && at(1) < 6,
    higherGoesFurther: at(2.2) > at(1) + 1
  };
});

// ------------------------------------------------ the designer draws ramps
// CONNECT is RESUME once a match is running, so the page is reloaded rather
// than talked out of the room it is already in.
await page.reload();
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'ramp');
await page.fill('#roominput', 'level design');
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(500);
await page.fill('#dw', '40'); await page.fill('#dl', '40'); await page.fill('#dh', '14');
await page.click('#dstart');
await page.waitForTimeout(600);
await must(await page.evaluate(() => !!window.game.design), 'the designer did not open');

R.shapeToggle = await page.evaluate(() => {
  const d = window.game.design;
  const key = code => dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  const before = d.shape;
  key('KeyF');
  const after = d.shape;
  key('KeyF');
  return { before, after, back: d.shape, toggles: before === 0 && after === 1 && d.shape === 0 };
});

// draw a ramp on the floor and walk up it, in the room that was just built
R.designedRamp = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const aim = (pitch, yaw) => { g.player.pitch = pitch; g.player.yaw = yaw; d._camera(); d._tools(); };
  d.shape = 1;                                  // ramps
  d.color = 1;
  d.pos = { x: 0, y: 9, z: 6 };
  aim(-Math.PI / 2 + 0.02, 0);
  d._click();                                   // start on the floor under us
  aim(-0.75, 0);                                // drag out along -z
  d._click();
  d.pull = 3;
  d._commitRect();
  const made = d.level.boxes.at(-1);
  if (!made) return { made: false };
  g.world.syncLevel();
  await sleep(100);

  // the ramp is a solid, not a box
  const solid = g.world.solids.find(s => s.src === made);

  // and it can be walked up: start at its low end and press forward
  const lowEnd = made.z1;                       // the drag ran toward -z, so +z is low
  d.togglePlay();
  g.player.spawn({ x: (made.x0 + made.x1) / 2, y: 0.3, z: lowEnd + 1.5 });
  g.player.yaw = 0;                             // forward is -z, into the ramp
  g.player.pitch = 0;
  await sleep(400);
  const y0 = g.player.pos.y;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  // the peak, not the end: a 9 m ramp is crossed in a second and a half and
  // walking off the top puts you straight back on the floor
  let peak = y0;
  for (let i = 0; i < 22; i++) { await sleep(100); peak = Math.max(peak, g.player.pos.y); }
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  await sleep(200);
  d.togglePlay();
  return {
    made: true, shape: made.shape, isSolid: !!solid,
    turned: !!(made.rx || made.ry || made.rz),
    size: [+(made.x1 - made.x0).toFixed(2), +(made.y1 - made.y0).toFixed(2), +(made.z1 - made.z0).toFixed(2)],
    y0: +y0.toFixed(2), peak: +peak.toFixed(2),
    climbed: peak > y0 + 1.2
  };
});

// ------------------------------------------------------------ rotation
R.rotateKey = await page.evaluate(() => {
  const d = window.game.design;
  const key = (code, shift = false) =>
    dispatchEvent(new KeyboardEvent('keydown', { code, shiftKey: shift, bubbles: true }));
  d.shape = 0;
  const made = d.level.add({ x: -6, y: 0, z: -6 }, { x: 6, y: 3, z: -5 }, 2);
  d.selected = made;
  d._changed();
  d.axis = 1;
  const before = [made.rx, made.ry, made.rz];
  // Euler angles are not unique — two quarter turns about Y come back out as
  // (pi, 0, pi), which is the same rotation written differently. So the
  // assertion is on the shape's footprint, not on the numbers behind it.
  const footprint = () => {
    window.game.world.syncLevel();
    const s = window.game.world.solids.find(x => x.src === made);
    return s ? [+(s.max.x - s.min.x).toFixed(2), +(s.max.z - s.min.z).toFixed(2)] : null;
  };
  const upright = [+(made.x1 - made.x0).toFixed(2), +(made.z1 - made.z0).toFixed(2)];
  key('KeyR');
  const afterOne = footprint();
  key('KeyR');
  const afterTwo = footprint();
  key('KeyR', true);                            // shift is the fine step
  const afterFine = footprint();
  d.axis = 1;
  made.rx = made.ry = made.rz = 0;
  d._changed();
  key('KeyX');                                  // X walks the axis on
  const axisAfterX = d.axis;
  return {
    startedUpright: before.every(v => v === 0),
    upright, afterOne, afterTwo, afterFine,
    // 12 x 1 turned a quarter is 1 x 12, and turned again is 12 x 1 once more
    quarterTurn: Math.abs(afterOne[0] - upright[1]) < 0.02 && Math.abs(afterOne[1] - upright[0]) < 0.02,
    halfTurn: Math.abs(afterTwo[0] - upright[0]) < 0.02 && Math.abs(afterTwo[1] - upright[1]) < 0.02,
    // a fine step is neither of those two footprints
    fineStepIsSmaller: Math.abs(afterFine[0] - afterTwo[0]) > 0.1,
    axisAfterX, axisAdvanced: axisAfterX === 2,
    id: made.id
  };
});

// The decisive one: a turned wall blocks along the axis it was turned onto, and
// no longer blocks along the one it left.
R.turnedWallBlocks = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  for (const b of [...d.level.boxes]) d.level.remove(b);
  // 12 m along x, 1 m along z, 4 m tall, at the origin
  const wall = d.level.add({ x: -6, y: 0, z: -0.5 }, { x: 6, y: 4, z: 0.5 }, 5);
  d.selected = wall;
  d._changed();
  await sleep(80);
  const diag = {
    boxes: g.world.boxes.length, solids: g.world.solids.length,
    wallInBoxes: g.world.boxes.filter(w => w.src === wall).length,
    rec: { x0: wall.x0, z0: wall.z0, x1: wall.x1, z1: wall.z1, y0: wall.y0, y1: wall.y1 }
  };

  // forward is (-sin yaw, -cos yaw): yaw 0 walks toward -z, yaw pi/2 toward -x
  const walkInto = async (fromX, fromZ, yaw) => {
    d.ghost = false;
    g.player.spawn({ x: fromX, y: 0.3, z: fromZ });
    g.player.yaw = yaw; g.player.pitch = 0;
    await sleep(300);
    const startAt = { x: +g.player.pos.x.toFixed(2), z: +g.player.pos.z.toFixed(2) };
    const trail = [];
    dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    for (let i = 0; i < 13; i++) {
      await sleep(150);
      trail.push([+g.player.pos.x.toFixed(1), +g.player.pos.z.toFixed(1),
                  +g.player.pos.y.toFixed(1), g.world.boxes.length]);
    }
    dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    await sleep(120);
    d.ghost = true;
    return { from: startAt, trail, x: +g.player.pos.x.toFixed(2), z: +g.player.pos.z.toFixed(2) };
  };

  // Two probes, chosen so each meets the wall in exactly one of its two
  // orientations. A runs down z at x=4: the upright wall spans x -6..6 and is in
  // the way, the turned one only spans x -0.5..0.5 and is not. B runs down x at
  // z=4, which is the other way round.
  const uprightA = await walkInto(4, 8, 0);
  const uprightB = await walkInto(8, 4, Math.PI / 2);

  wall.ry = Math.PI / 2;                       // a quarter turn about Y
  d._changed();
  await sleep(80);
  const turnedA = await walkInto(4, 8, 0);
  const turnedB = await walkInto(8, 4, Math.PI / 2);

  return {
    diag, uprightA, uprightB, turnedA, turnedB,
    uprightBlocked: uprightA.z > 0.5,          // stopped at the wall's near face
    // ...and stopped, rather than being lifted onto the top of it
    didNotClimbIt: uprightA.trail.every(t => t[2] < 1),
    uprightLetsThroughTheOtherWay: uprightB.x < 0,
    turnedLetsThrough: turnedA.z < 0,          // walked past where it used to be
    turnedBlocks: turnedB.x > 0.5              // and now stops the other probe
  };
});

// ------------------------------------------------------- the gizmo, dragged
R.gizmo = await page.evaluate(async () => {
  const g = window.game, d = g.design;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  d.ghost = true;
  for (const b of [...d.level.boxes]) d.level.remove(b);
  const box = d.level.add({ x: -1.5, y: 2, z: -1.5 }, { x: 1.5, y: 5, z: 1.5 }, 0);
  d.selected = box;
  d._changed();
  await sleep(80);

  // stand off to one side and look at the middle of it
  const c = d._gizmoCentre(box);
  const r = d._gizmoRadius(box);
  d.pos = { x: c.x, y: c.y + 0.001, z: c.z + 12 };
  g.player.pitch = 0; g.player.yaw = 0;         // looking at -z, straight at it
  d.mouseFree = false;
  d._camera();
  d._tools();

  // aim at the near edge of the Y ring rather than the middle of the object
  const ringPoint = { x: c.x, y: c.y, z: c.z + r };
  const dx = ringPoint.x - d.pos.x, dy = ringPoint.y - d.pos.y, dz = ringPoint.z - d.pos.z;
  const len = Math.hypot(dx, dy, dz);
  d.ray = { origin: { ...d.pos }, dir: { x: dx / len, y: dy / len, z: dz / len } };
  const hit = d._ringUnderRay();
  if (!hit) return { grabbed: false, r, c };

  d._startRingDrag(hit);
  const dragging = !!d.drag;
  const axis = d.drag.axis;
  d.snap = false;
  // pull a quarter of the way round the ring
  const to = { x: c.x + r, y: c.y, z: c.z };
  const ex = to.x - d.pos.x, ey = to.y - d.pos.y, ez = to.z - d.pos.z;
  const elen = Math.hypot(ex, ey, ez);
  d.ray = { origin: { ...d.pos }, dir: { x: ex / elen, y: ey / elen, z: ez / elen } };
  d._dragRing();
  const turned = +box.ry.toFixed(3);
  d._endDrag();
  return {
    grabbed: true, dragging, axis, turned,
    stoppedOnRelease: d.drag === null,
    // a quarter of the ring is a quarter turn
    quarterish: Math.abs(Math.abs(turned) - Math.PI / 2) < 0.02
  };
});

// -------------------------------------------------- shape and turn survive a seed
R.seedKeepsShape = await page.evaluate(() => {
  const d = window.game.design;
  for (const b of [...d.level.boxes]) d.level.remove(b);
  d.level.add({ x: -3, y: 0, z: -3 }, { x: 3, y: 3, z: 3 }, 4, 1, [0.25, 1.25, -0.5]);
  const seed = d.level.encode();
  const back = window.__Level.decode(seed);
  const a = d.level.boxes[0], b = back.boxes[0];
  return {
    seed: seed.slice(0, 30),
    shape: b.shape,
    rot: [b.rx, b.ry, b.rz].map(v => +v.toFixed(3)),
    // milliradians is the stored precision, so a thousandth is the tolerance
    matches: b.shape === a.shape &&
             Math.abs(b.rx - a.rx) < 0.002 &&
             Math.abs(b.ry - a.ry) < 0.002 &&
             Math.abs(b.rz - a.rz) < 0.002
  };
});

// a seed written before any of this existed still loads
R.oldSeedStillLoads = await page.evaluate(() => {
  // PA1: dims, shell colours, one box, checksum — no shape and no rotation
  const body = '190,190,dc-332222-0,0,0,3c,3c,3c,1';
  let h = 2166136261;
  for (let i = 0; i < body.length; i++) { h ^= body.charCodeAt(i); h = Math.imul(h, 16777619); }
  const seed = 'PA1-' + body + '-' + (h >>> 0).toString(36);
  try {
    const l = window.__Level.decode(seed);
    return { loaded: true, boxes: l.boxes.length, shape: l.boxes[0].shape,
             upright: !l.boxes[0].rx && !l.boxes[0].ry && !l.boxes[0].rz };
  } catch (e) { return { loaded: false, error: e.message }; }
});

// -------------------------------------------------------------------- verdict
// eight stairs plus the eight corner fillets, floor and ceiling
if (R.arena.ramps !== 16) fail.push('the arena does not have sixteen ramps: ' + JSON.stringify(R.arena));
if (!R.every45) fail.push('a slope in the default map is not 45 degrees: ' + JSON.stringify(R.pitches));
if (!R.fillet.keptTheirWall) fail.push('a corner fillet turned a wall-walker over — only a portal may do that: ' + JSON.stringify(R.fillet));
if (!R.fillet.walkedOnTheFillet) fail.push('a wall-walker could not stand on the corner fillet at all: ' + JSON.stringify(R.fillet));
if (!R.fillet.stayedUprightOnTheWayIn) fail.push('walking into a corner the right way up turned the player over: ' + JSON.stringify(R.fillet));
if (R.arena.boxesInTheRampsPlace > 0) fail.push('a flight of steps is still in the arena: ' + R.arena.boxesInTheRampsPlace);
if (!R.walkUp.reachedThePlatform) fail.push('could not walk up an arena ramp: ' + JSON.stringify(R.walkUp));
if (!R.doesNotSlide.standingOnTheRamp) fail.push('did not end up standing on the ramp: ' + JSON.stringify(R.doesNotSlide));
if (R.doesNotSlide.driftX > 0.15) fail.push('slid down the ramp while standing still: ' + JSON.stringify(R.doesNotSlide));
if (!R.hitscan.stoppedByTheRamp) fail.push('a shot went through the ramp: ' + JSON.stringify(R.hitscan));
if (!R.hitscan.higherGoesFurther) fail.push('the ramp stops shots at every height, so it is not a ramp: ' + JSON.stringify(R.hitscan));
if (!R.shapeToggle.toggles) fail.push('F does not switch between boxes and ramps: ' + JSON.stringify(R.shapeToggle));
if (!R.designedRamp.made || R.designedRamp.shape !== 1) fail.push('the designer did not make a ramp: ' + JSON.stringify(R.designedRamp));
if (!R.designedRamp.isSolid) fail.push('the designed ramp never became a solid');
if (!R.designedRamp.turned) fail.push('the designed ramp was not aimed along the drag');
if (!R.designedRamp.climbed) fail.push('the designed ramp could not be walked up: ' + JSON.stringify(R.designedRamp));
if (!R.rotateKey.quarterTurn) fail.push('R did not turn the footprint a quarter: ' + JSON.stringify(R.rotateKey));
if (!R.rotateKey.halfTurn) fail.push('two presses of R did not make a half turn: ' + JSON.stringify(R.rotateKey));
if (!R.rotateKey.fineStepIsSmaller) fail.push('shift+R is not a finer step: ' + JSON.stringify(R.rotateKey));
if (!R.rotateKey.axisAdvanced) fail.push('X did not move to the next axis: ' + R.rotateKey.axisAfterX);
if (!R.turnedWallBlocks.uprightBlocked) fail.push('the upright wall did not block: ' + JSON.stringify(R.turnedWallBlocks));
if (!R.turnedWallBlocks.didNotClimbIt) fail.push('walking into a 4 m wall climbed it: ' + JSON.stringify(R.turnedWallBlocks.uprightA));
if (!R.turnedWallBlocks.uprightLetsThroughTheOtherWay) fail.push('the upright wall blocked a probe it should have missed: ' + JSON.stringify(R.turnedWallBlocks));
if (!R.turnedWallBlocks.turnedLetsThrough) fail.push('the turned wall still blocks where it used to: ' + JSON.stringify(R.turnedWallBlocks));
if (!R.turnedWallBlocks.turnedBlocks) fail.push('the turned wall does not block where it now is: ' + JSON.stringify(R.turnedWallBlocks));
if (!R.gizmo.grabbed) fail.push('the rotation ring could not be grabbed: ' + JSON.stringify(R.gizmo));
if (R.gizmo.axis !== 1) fail.push('the wrong ring was grabbed: ' + R.gizmo.axis);
if (!R.gizmo.quarterish) fail.push('dragging a quarter of the ring was not a quarter turn: ' + JSON.stringify(R.gizmo));
if (!R.gizmo.stoppedOnRelease) fail.push('the drag did not stop on release');
if (!R.seedKeepsShape.matches) fail.push('the seed lost the shape or the turn: ' + JSON.stringify(R.seedKeepsShape));
if (!R.oldSeedStillLoads.loaded) fail.push('a seed from before ramps existed no longer loads: ' + JSON.stringify(R.oldSeedStillLoads));
if (errs.length) fail.push('page errors: ' + errs.join(' | '));

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
if (fail.length) { console.log('FAIL: ' + fail.join('\n      ')); await browser.close(); process.exit(1); }
console.log('PASS — ramps are walkable and solid to bullets, and a turned box collides where it was turned to');
await browser.close();
