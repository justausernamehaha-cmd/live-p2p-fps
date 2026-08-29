// Movement-direction regression test.
//
// The bug this exists for: the movement basis was mirrored in z, so W/S inverted
// when facing along z, A/D inverted when facing along x, and both felt swapped in
// between. An earlier test measured only *how far* the player moved, which passed
// happily while the player walked backwards. This one measures direction.
//
//   ./serve.sh 8080 &   then   node test/movement.mjs
//
import { chromium } from 'playwright';
const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL); await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'move'); await page.fill('#roominput', 'solo-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForTimeout(2000);

const YAWS = [0, 30, 45, 90, 135, 180, 225, 270, 315];
const KEYS = { KeyW: 'W', KeyD: 'D', KeyS: 'S', KeyA: 'A' };

const results = await page.evaluate(async ({ YAWS, KEYS }) => {
  const g = window.game;
  const out = [];
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const realBoxes = g.world.boxes;
  const realSolids = g.world.solids;
  g.world.boxes = realBoxes.filter(b => b.max.y === 0 && b.max.x - b.min.x > 50);
  g.world.solids = [];          // the ramps would deflect a run across the floor
  for (const deg of YAWS) {
    for (const code of Object.keys(KEYS)) {
      const yaw = deg * Math.PI / 180;
      // On the ground, on a bare floor. Ground movement is the direct-control
      // path where all four keys matter; in the air only the strafe keys steer,
      // by design, so measuring there would test the wrong thing. The level is
      // stripped to its floor so nothing can deflect the run.
      g.player.pos = { x: 0, y: 0.2, z: 0 };
      g.player.vel = { x: 0, y: 0, z: 0 };
      g.player.yaw = yaw; g.player.pitch = 0;
      g.player.recoil = 0; g.player.recoilYaw = 0;
      await sleep(160);          // settle onto the floor first
      const start = { x: g.player.pos.x, z: g.player.pos.z };
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      await sleep(320);
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      const dx = g.player.pos.x - start.x, dz = g.player.pos.z - start.z;
      const len = Math.hypot(dx, dz);

      // the truth we compare against is the camera's own basis
      const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
      const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      const want = { KeyW: fwd, KeyS: { x: -fwd.x, z: -fwd.z },
                     KeyD: right, KeyA: { x: -right.x, z: -right.z } }[code];
      const dot = len > 0.01 ? (dx / len) * want.x + (dz / len) * want.z : 0;
      out.push({ yaw: deg, key: KEYS[code], moved: +len.toFixed(2),
                 errDeg: len > 0.01 ? +(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toFixed(1) : 999 });
    }
  }
  g.world.boxes = realBoxes;
  g.world.solids = realSolids;
  return out;
}, { YAWS, KEYS });

let bad = 0;
const byYaw = {};
for (const r of results) {
  (byYaw[r.yaw] ??= []).push(`${r.key}:${r.errDeg <= 5 ? 'ok' : r.errDeg + '°off'}`);
  if (r.errDeg > 5) bad++;
}
console.log('yaw   W/D/S/A direction error vs the camera basis');
for (const y of Object.keys(byYaw)) console.log(String(y).padStart(4) + '°  ' + byYaw[y].join('  '));
console.log(`\n${results.length - bad}/${results.length} directions correct`);
console.log('page errors:', errs.length ? errs : 'none');
await browser.close();
process.exit(bad ? 1 : 0);
