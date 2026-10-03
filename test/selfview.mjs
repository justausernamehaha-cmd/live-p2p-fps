// You never see your own body or gun in the portal you are standing in.
//
// Standing half into a mouth and facing it, the picture in that mouth is drawn
// from your own eye carried through the portal, so the part of your body that
// hangs out of the far mouth sits right in front of that camera: you saw your
// own back and gun. First person never draws itself, so that view must not.
// The control: stand in front of the OTHER mouth and look into it, and you must
// still see yourself over by the first one — the fix must not just hide you.
//
// Independent truth: pixels read back out of the portal's own render target,
// with your body painted a colour nothing else in the level has.
//
//   ./serve.sh 8080 &   then   node test/selfview.mjs
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
await page.fill('#roominput', 'selfview-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
  const g = window.game, p = g.player, sleep = ms => new Promise(f => setTimeout(f, ms));
  g.myColor = 0xff00ff;
  // two mouths on the mid-field cover wall across z at x = 44 (flat floor, no
  // fillet at its foot), on its -x face, 6 m apart
  const wall = g.world.boxes.find(b => b.mover === undefined && b.min.y === 0 &&
    Math.abs(b.max.y - 2.4) < 1e-6 && b.max.z - b.min.z > 20 && b.max.x - b.min.x < 1.5 && b.min.x > 40);
  if (!wall) return { noWall: true };
  const X = wall.min.x, zm = (wall.min.z + wall.max.z) / 2;
  const A = { c: { x: X, y: 1.0, z: zm - 3 }, n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 };
  const B = { c: { x: X, y: 1.0, z: zm + 3 }, n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 };
  g.portals.clear();
  const pa = g.portals.place('me', 'a', A);
  const pb = g.portals.place('me', 'b', B);
  const yawTo = (fx, fz) => Math.atan2(-fx, -fz);
  // everything of yours that can be drawn — body, head, gun, ghost — in magenta
  const paint = () => g.selfAvatar.root.traverse(o => {
    if (o.isMesh && o.material && o.material.color) o.material.color.setHex(0xff00ff);
  });
  const hold = async (pos, yaw, pitch = 0) => {
    for (let i = 0; i < 20; i++) {           // keep it pinned while frames render
      p.pos = { ...pos }; p.vel = { x: 0, y: 0, z: 0 };
      p.up = { x: 0, y: 1, z: 0 }; p.yaw = yaw; p.pitch = pitch; p.crouchT = 0;
      paint();
      await sleep(16);
    }
  };
  const magenta = portal => {
    const t = portal.target;
    if (!t) return -1;
    const buf = new Uint8Array(t.width * t.height * 4);
    g.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] > 140 && buf[i + 2] > 140 && buf[i + 1] < 100) n++;
    }
    return n;
  };
  const out = {};
  // 1. standing in A, a few cm into it, facing into it
  await hold({ x: X - 0.02, y: 0.02, z: A.c.z }, yawTo(1, 0), -0.35);
  out.inMouth = g.selfAvatar.mouth === pa;
  out.selfInOwnMouth = magenta(pa);
  // 2. control: 3 m in front of A, looking into B from beside it
  await hold({ x: X - 3, y: 0.02, z: A.c.z }, yawTo(3, 6));
  out.selfThroughOther = magenta(pb);
  return out;
});

const fail = [];
if (R.noWall) fail.push('the cover wall was not found');
if (!R.inMouth) fail.push('the setup did not stand the body in the mouth: ' + JSON.stringify(R));
if (R.selfInOwnMouth !== 0) fail.push(`your own body/gun is drawn in the mouth you stand in (${R.selfInOwnMouth} px)`);
if (!(R.selfThroughOther > 50)) fail.push(`the control failed: you should see yourself through the other mouth (${R.selfThroughOther} px)`);
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS: first person never sees itself in its own mouth');
await browser.close();
process.exit(fail.length ? 1 : 0);
