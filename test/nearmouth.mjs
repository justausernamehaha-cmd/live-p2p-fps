// The last few centimetres before a mouth still show what is through it.
//
// A mouth's picture stands 2.4 cm proud of its wall and the camera's near plane
// is 1.5 cm, so an eye closer than about 4 cm had the picture clipped away and
// saw the bare wall until the hand-over at the surface: walk in slowly, or stop
// there, and you were looking at a wall and then somewhere else.
//
// Independent truth: the mouth's own render target is drawn with the same
// viewport and projection as the screen, so wherever the mouth covers the screen
// the two pictures must be the same picture. The control is 15 cm out, where it
// always worked.
//
//   ./serve.sh 8080 &   then   node test/nearmouth.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({ viewport: { width: 800, height: 500 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'me');
await page.fill('#roominput', 'nearmouth-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
  const g = window.game, p = g.player, sleep = ms => new Promise(f => setTimeout(f, ms));
  // two mouths on the mid-field cover wall (flat floor at its foot), 6 m apart
  const wall = g.world.boxes.find(b => b.mover === undefined && b.min.y === 0 &&
    Math.abs(b.max.y - 2.4) < 1e-6 && b.max.z - b.min.z > 20 && b.max.x - b.min.x < 1.5 && b.min.x > 40);
  if (!wall) return { noWall: true };
  const X = wall.min.x, zm = (wall.min.z + wall.max.z) / 2;
  const at = z => ({ c: { x: X, y: 1.0, z }, n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  g.portals.clear();
  const pa = g.portals.place('me', 'a', at(zm - 3));
  g.portals.place('me', 'b', at(zm + 3));
  const yawTo = (fx, fz) => Math.atan2(-fx, -fz);
  const hold = async (d, yaw) => {
    for (let i = 0; i < 20; i++) {
      p.pos = { x: X - d, y: 0.02, z: zm - 3 }; p.vel = { x: 0, y: 0, z: 0 };
      p.up = { x: 0, y: 1, z: 0 }; p.yaw = yaw; p.pitch = 0; p.crouchT = 0;
      await sleep(16);
    }
  };
  const screen = g.portals._makeTarget();
  const read = t => {
    const buf = new Uint8Array(t.width * t.height * 4);
    g.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
    return buf;
  };
  /** Mean difference, 0-255, between the screen and the mouth's picture over
   *  the left `part` of the frame. */
  const differs = part => {
    const t = pa.target;
    screen.setSize(t.width, t.height);
    g.renderer.setRenderTarget(screen);
    g.renderer.clear();
    g.renderer.render(g.scene, g.camera);
    g.renderer.setRenderTarget(null);
    const a = read(screen), b = read(t);
    let sum = 0, n = 0;
    for (let y = 0; y < t.height; y += 3) for (let x = 0; x < t.width * part; x += 3) {
      const i = (y * t.width + x) * 4;
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      n += 3;
    }
    return +(sum / n).toFixed(2);
  };
  const out = { facing: {}, aslant: {} };
  for (const d of [0.15, 0.05, 0.03, 0.01, 0.002]) {
    await hold(d, yawTo(1, 0));
    out.facing[d] = differs(1);          // looking straight in: the mouth is the whole screen
    await hold(d, yawTo(1, 1));
    out.aslant[d] = differs(0.3);        // 45 degrees along the wall: it is the left of it
    out.crossed = p.portalCount;
  }
  return out;
});

const fail = [];
if (R.noWall) fail.push('the cover wall was not found');
else {
  if (R.crossed) fail.push('the body went through; the holds were meant to stop short');
  for (const [name, set] of [['facing it', R.facing], ['at 45 degrees', R.aslant]]) {
    if (!(set[0.15] < 6)) fail.push(`the control failed ${name}: screen and picture differ by ${set[0.15]} at 15 cm`);
    for (const d of [0.05, 0.03, 0.01, 0.002]) {
      if (!(set[d] < 6)) fail.push(`${name}, ${d * 100} cm from the wall the screen is not the mouth's picture (differs by ${set[d]})`);
    }
  }
}
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS: a mouth shows what is through it right up to the surface');
await browser.close();
process.exit(fail.length ? 1 : 0);
