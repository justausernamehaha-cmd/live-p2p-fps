// A mouth turned to an angle in its wall (what fitPortal now does when neither
// upright nor lying down fits) is still a hole of the right shape to a body.
//
// The mouth is turned 45 degrees on the mid-field cover wall, its long axis
// running up-left to down-right. Walking at its middle goes through to the
// other mouth. Walking at the wall beside it — inside the square that bounds
// the oval, where a hole cut square would let you in — is stopped by the wall.
// The control is the same walk at the bare wall.
//
//   ./serve.sh 8080 &   then   node test/turnedmouth.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({ viewport: { width: 640, height: 400 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'me');
await page.fill('#roominput', 'turned-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1000);

const R = await page.evaluate(async () => {
  const g = window.game, p = g.player, sleep = ms => new Promise(f => setTimeout(f, ms));
  const wall = g.world.boxes.find(b => b.mover === undefined && b.min.y === 0 &&
    Math.abs(b.max.y - 2.4) < 1e-6 && b.max.z - b.min.z > 20 && b.max.x - b.min.x < 1.5 && b.min.x > 40);
  if (!wall) return { noWall: true };
  const X = wall.min.x, zm = (wall.min.z + wall.max.z) / 2, s = Math.SQRT1_2;
  const me = g.portals.selfId;
  g.portals.clear();
  const A = g.portals.place(me, 'a', { c: { x: X, y: 1.0, z: zm - 4 }, n: { x: -1, y: 0, z: 0 },
    u: { x: 0, y: s, z: s }, v: { x: 0, y: s, z: -s }, mover: -1 });
  const B = g.portals.place(me, 'b', { c: { x: X, y: 1.0, z: zm + 4 }, n: { x: -1, y: 0, z: 0 },
    u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  const keys = (...on) => { g.input.held.clear(); for (const k of on) g.input.held.add(k); g.input._recalcKeys(); };
  const walkAt = async z => {
    keys();
    p.pos = { x: X - 1.5, y: 0.02, z }; p.vel = { x: 0, y: 0, z: 0 }; p.up = { x: 0, y: 1, z: 0 };
    p.yaw = Math.atan2(-1, 0); p.pitch = 0; p.crouchT = 0; p.hp = 100; p.alive = true;
    g.protectedUntil = 0;
    await sleep(150);
    const before = p.portalCount, esc = p.escapes;
    keys('fwd');
    let deepest = -Infinity;
    for (let i = 0; i < 70 && p.portalCount === before; i++) { await sleep(16); deepest = Math.max(deepest, p.pos.x); }
    keys();
    await sleep(100);
    return { through: p.portalCount - before, deepest: +deepest.toFixed(2), alive: p.alive, escapes: p.escapes - esc,
             fromB: +Math.hypot(p.pos.x - B.c.x, p.pos.z - B.c.z).toFixed(2) };
  };
  const out = { face: +X.toFixed(2) };
  out.bare = await walkAt(zm);                       // no mouth here at all
  out.middle = await walkAt(A.c.z);                  // the middle of the turned mouth
  p.up = { x: 0, y: 1, z: 0 };
  // 0.75 m toward +z: the oval is down by the floor on this side, nowhere near a
  // standing body's middle or head, though the oval's bounding square reaches 0.86
  out.beside = await walkAt(A.c.z + 0.75);
  g.portals.clear();
  return out;
});

const fail = [];
if (R.noWall) fail.push('the cover wall was not found');
else {
  const stopped = r => r.through === 0 && r.deepest < R.face - 0.1;
  if (!stopped(R.bare)) fail.push('the control failed: the bare wall did not stop the walk: ' + JSON.stringify(R.bare));
  if (R.middle.through !== 1 || !R.middle.alive || R.middle.escapes || R.middle.fromB > 4)
    fail.push('walking at the middle of a turned mouth did not come out of the other one: ' + JSON.stringify(R.middle));
  if (!stopped(R.beside) || !R.beside.alive || R.beside.escapes)
    fail.push('the wall beside a turned mouth, inside its bounding square, let a body in: ' + JSON.stringify(R.beside));
}
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS: a turned mouth is a hole where the oval is and a wall everywhere else');
await browser.close();
process.exit(fail.length ? 1 : 0);
