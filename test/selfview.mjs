// In first person you see the far half of yourself, never the half at your eye.
//
// Standing half into a mouth and facing it, the picture in that mouth is drawn
// from your own eye carried through the portal, so the part of your body that
// hangs out of the far mouth sits right in front of that camera: you saw your
// own back and gun. First person never draws itself, so that view must not.
// But the half that is far from the eye is a body like any other: looking
// along the wall you see your far half hanging out of the other mouth, and the
// picture in your own mouth shows the half of you still on this side.
// (That you are drawn at all through a mouth you are NOT standing in is
// portals.mjs's "you can see yourself through a portal". It used to be checked
// here too, 3 m out and looking into the other mouth, by counting the body
// anywhere in that mouth's picture — but two mouths side by side on one wall
// never show you yourself, the body was in a part of the picture the oval does
// not show, and a view is now only drawn where its mouth shows.)
//
// Independent truth: pixels read back out of the portal's own render target,
// with your body painted magenta and its far half green, colours nothing else
// in the level has.
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
  // everything of yours that can be drawn — body, head, gun — in magenta, and
  // the half out of the far mouth in green
  const tint = (root, hex) => root.traverse(o => {
    if (!o.isMesh || !o.material || !o.material.color) return;
    o.material.color.setHex(hex);
    if (o.material.emissive) o.material.emissive.setHex(hex);
  });
  const paint = () => { tint(g.selfAvatar.group, 0xff00ff); tint(g.selfAvatar.ghost, 0x00ff00); };
  const hold = async (pos, yaw, pitch = 0) => {
    for (let i = 0; i < 20; i++) {           // keep it pinned while frames render
      p.pos = { ...pos }; p.vel = { x: 0, y: 0, z: 0 };
      p.up = { x: 0, y: 1, z: 0 }; p.yaw = yaw; p.pitch = pitch; p.crouchT = 0;
      paint();
      await sleep(16);
    }
  };
  const count = (t, green) => {
    if (!t) return -1;
    const buf = new Uint8Array(t.width * t.height * 4);
    g.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (green ? buf[i + 1] > 140 && buf[i] < 100 && buf[i + 2] < 100
                : buf[i] > 140 && buf[i + 2] > 140 && buf[i + 1] < 100) n++;
    }
    return n;
  };
  const magenta = portal => count(portal.target, false);
  const green = portal => count(portal.target, true);
  // your own view, drawn again into a target that can be read back
  // (sized like a portal's own picture, once there is one)
  const screen = g.portals._makeTarget();
  const own = isGreen => {
    screen.setSize(pa.target.width, pa.target.height);
    g.renderer.setRenderTarget(screen);
    g.renderer.clear();
    g.renderer.render(g.scene, g.camera);
    g.renderer.setRenderTarget(null);
    return count(screen, isGreen);
  };
  const out = {};
  // 1. standing in A, a few cm into it, facing into it
  await hold({ x: X - 0.02, y: 0.02, z: A.c.z }, yawTo(1, 0), -0.35);
  out.inMouth = g.selfAvatar.mouth === pa;
  out.selfInOwnMouth = magenta(pa);
  out.farHalfInOwnMouth = green(pa);
  // 2. still in A, looking along the wall at B: the far half hangs out of B in
  //    your own view, and A's picture (drawn from B) shows the half left here
  await hold({ x: X - 0.02, y: 0.02, z: A.c.z }, yawTo(0, 1));
  out.stillInMouth = g.selfAvatar.mouth === pa;
  out.farHalfOnScreen = own(true);
  out.nearHalfFromFarMouth = magenta(pa);
  out.farHalfFromFarMouth = green(pa);
  // ...and with your back to the wall no mouth is on screen, so nothing of the
  //    body the camera is in may be (its gun is right in front of the lens)
  await hold({ x: X - 0.02, y: 0.02, z: A.c.z }, yawTo(-1, 0));
  out.nearHalfOnScreen = own(false);
  // 3. 3 m in front of A, nothing of you in any mouth: no far half anywhere
  await hold({ x: X - 3, y: 0.02, z: A.c.z }, yawTo(3, 6));
  out.greenWithNoFarHalf = own(true);
  // 4. behind the wall, level with A: wholly past its surface is not in it
  await hold({ x: wall.max.x + 0.5, y: 0.02, z: A.c.z }, yawTo(1, 0));
  out.mouthFromBehindTheWall = g.selfAvatar.mouth ? g.selfAvatar.mouth.side : null;
  return out;
});

const fail = [];
if (R.noWall) fail.push('the cover wall was not found');
if (!R.inMouth) fail.push('the setup did not stand the body in the mouth: ' + JSON.stringify(R));
if (R.selfInOwnMouth !== 0) fail.push(`your own body/gun is drawn in the mouth you stand in (${R.selfInOwnMouth} px)`);
if (R.farHalfInOwnMouth !== 0) fail.push(`the half at your eye is drawn in the mouth you stand in (${R.farHalfInOwnMouth} px)`);
if (!R.stillInMouth) fail.push('the body left the mouth when it turned');
if (!(R.farHalfOnScreen > 20)) fail.push(`your far half is not on your own screen (${R.farHalfOnScreen} px)`);
if (R.nearHalfOnScreen !== 0) fail.push(`your own screen draws the body the camera is in (${R.nearHalfOnScreen} px)`);
if (!(R.nearHalfFromFarMouth > 20)) fail.push(`your own mouth does not show the half of you still outside it (${R.nearHalfFromFarMouth} px)`);
if (R.farHalfFromFarMouth !== 0) fail.push(`your own mouth shows the half at its camera (${R.farHalfFromFarMouth} px)`);
if (R.mouthFromBehindTheWall !== null) fail.push(`standing behind a mouth's wall counts as standing in it (${R.mouthFromBehindTheWall})`);
if (R.greenWithNoFarHalf !== 0) fail.push(`something else in the level is the far half's green (${R.greenWithNoFarHalf} px)`);
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS: first person sees its far half and never the one at its eye');
await browser.close();
process.exit(fail.length ? 1 : 0);
