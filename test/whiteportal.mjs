// White Out against portals and moving platforms, and a portal's border.
//
//   * the border: standing beside a mouth and facing away from the wall it is
//     on, with the mouth still at the edge of the screen, the thick ring is
//     still drawn. The control puts the ring back in the depth sort, where the
//     disc paints over it — so the setup is known to reproduce the report
//     before the fix is believed.
//   * a stroke takes a portal: paint over a mouth whitens it and it is still
//     there; let go and it is gone, its partner is not, and the peers are told
//     which one. A peer's stroke takes the mouths it names.
//   * a mark rides its platform: paint a dot on the north shuttle and hold. The
//     white is where that spot of the shuttle has got to, not where it was
//     painted; once let go, a bullet goes through the shuttle at that spot and
//     is stopped where the dot was first put.
//
// Independent truth: pixels read back from the canvas, and the game's own
// hitscan, neither of which the White Out code is asked about itself.
//
//   ./serve.sh 8080 &   then   node test/whiteportal.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({ viewport: { width: 800, height: 500 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
// three.js reports a shader that will not compile on the console, not as an exception
page.on('console', m => { if (m.type() === 'error' && /THREE|shader/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 400)); });
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'me');
await page.fill('#roominput', 'whiteportal-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(3400);                    // the spawn shield: no firing under it

// helpers every step uses, kept on the page
await page.evaluate(() => {
  const g = window.game, p = g.player;
  const T = window.T = {};
  T.sleep = ms => new Promise(f => setTimeout(f, ms));
  T.frames = n => new Promise(f => { const go = () => (n-- > 0 ? requestAnimationFrame(go) : f()); go(); });
  T.pin = (pos, dir) => {
    const l = Math.hypot(dir.x, dir.y, dir.z);
    const a = window.__frame.anglesIn({ x: 0, y: 1, z: 0 }, { x: dir.x / l, y: dir.y / l, z: dir.z / l });
    p.pos = { ...pos }; p.vel = { x: 0, y: 0, z: 0 }; p.up = { x: 0, y: 1, z: 0 };
    p.yaw = a.yaw; p.pitch = a.pitch; p.recoil = 0; p.recoilYaw = 0; p.crouchT = 0;
  };
  T.hold = async (pos, dir, n = 20) => { for (let i = 0; i < n; i++) { T.pin(pos, dir); await T.sleep(16); } };
  // the whole canvas, rendered and read back in one task
  T.shot = () => {
    g._camera(0);
    g.renderer.setRenderTarget(null);
    g.renderer.render(g.scene, g.camera);
    const gl = g.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { px, w, h };
  };
  // mean brightness of the 4 x 4 pixels under a world point
  T.under = world => {
    const { px, w, h } = T.shot();
    const v = g.camera.position.clone().set(world.x, world.y, world.z).project(g.camera);
    const x = Math.round((v.x + 1) / 2 * w), y = Math.round((v.y + 1) / 2 * h);
    let s = 0;
    for (let j = -2; j < 2; j++) for (let i = -2; i < 2; i++) {
      const k = ((y + j) * w + x + i) * 4;
      s += (px[k] + px[k + 1] + px[k + 2]) / 3;
    }
    return +(s / 16).toFixed(1);
  };
  T.whiteOut = async () => {
    g._switch(g.loadout.switchTo(4, performance.now() / 1000));
    while (performance.now() / 1000 < g.loadout.state[4].readyAt + 0.3 || g.loadout.nextShot > performance.now() / 1000) await T.sleep(50);
  };
  // the mid-field cover wall across z at x = 44 (flat floor at its foot), -x face
  const wall = g.world.boxes.find(b => b.mover === undefined && b.min.y === 0 &&
    Math.abs(b.max.y - 2.4) < 1e-6 && b.max.z - b.min.z > 20 && b.max.x - b.min.x < 1.5 && b.min.x > 40);
  T.wall = wall;
  T.mouth = z => ({ c: { x: wall.min.x, y: 1.0, z }, n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
});
const R = {};
R.wall = await page.evaluate(() => !!window.T.wall);

// ------------------------------------------------------------- the border
R.ring = await page.evaluate(async () => {
  const g = window.game, T = window.T, X = T.wall.min.x, zm = (T.wall.min.z + T.wall.max.z) / 2;
  g.portals.clear();
  const me = g.portals.selfId;
  const pa = g.portals.place(me, 'a', T.mouth(zm - 3));
  g.portals.place(me, 'b', T.mouth(zm + 3));
  // a colour nothing else on screen has, added over the wall or the view
  pa.ring.material.color.setHex(0xff00ff);
  const magenta = () => {
    const { px } = T.shot();
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 215 && px[i + 2] > 215 && px[i + 1] < 185) n++;
    return n;
  };
  // 0.4 m off the wall, a metre and a half short of the mouth, looking along the
  // wall and a little AWAY from it: the mouth is at the right-hand edge of the view
  const pos = { x: X - 0.4, y: 0.02, z: zm - 3 - 1.5 }, away = { x: -0.3, y: 0, z: 1 };
  await T.hold(pos, away);
  g._camera(0);
  const fwd = g.camera.getWorldDirection(g.camera.position.clone());
  const out = { facingAway: +(fwd.x * pa.n.x + fwd.y * pa.n.y + fwd.z * pa.n.z).toFixed(3) };
  out.fixed = magenta();
  pa.ring.renderOrder = 0;                  // the control: back in the depth sort
  out.control = magenta();
  pa.ring.renderOrder = 1;
  // and from the front, where it never went missing
  await T.hold({ x: X - 4, y: 0.02, z: zm - 3 }, { x: 1, y: 0, z: 0 });
  out.fromFront = magenta();
  return out;
});

// ------------------------------------------------- a stroke takes a portal
R.take = await page.evaluate(async () => {
  const g = window.game, T = window.T, p = g.player, X = T.wall.min.x, zm = (T.wall.min.z + T.wall.max.z) / 2;
  g.portals.clear();
  g.world.eraseClear();
  const me = g.portals.selfId;
  g.portals.place(me, 'a', T.mouth(zm - 3));
  g.portals.place(me, 'b', T.mouth(zm + 3));
  const pair = () => g.portals.pairs.get(me);
  const sent = [];
  if (g.net) { const real = g.net.eraseOpen.bind(g.net); g.net.eraseOpen = (sid, kp) => { sent.push(kp); return real(sid, kp); }; }
  const pos = { x: X - 6, y: 0.02, z: zm - 3 };
  const spot = { x: X, y: 1.5, z: zm - 3 + 0.2 };              // inside mouth a, off its centre
  const aimAt = async target => {
    T.pin(pos, { x: 1, y: 0, z: 0 });
    await T.frames(2);
    const e = p.eye(0);
    return { x: target.x - e.x, y: target.y - e.y, z: target.z - e.z };
  };
  await T.whiteOut();
  const out = {};
  let d = await aimAt(spot);
  await T.hold(pos, d, 6);
  out.before = { a: !!pair().a, b: !!pair().b, pixel: T.under(spot) };
  g.input.held.add('fire');
  await T.hold(pos, d, 12);
  out.painting = { a: !!pair().a, b: !!pair().b, pixel: T.under(spot), stamps: g.world.erase.list.length, holes: g.world.erase.holes };
  g.input.held.delete('fire');
  await T.hold(pos, d, 6);
  out.released = { a: !!pair().a, b: !!pair().b, holes: g.world.erase.holes, links: g.portals.links().length, sent: [...sent] };

  // the control: a stroke on the bare wall a metre and a half clear of mouth b
  // takes nothing
  const posB = { x: X - 6, y: 0.02, z: zm + 3 };
  const bare = { x: X, y: 1.5, z: zm + 3 - 2.2 };
  await T.whiteOut();
  T.pin(posB, { x: 1, y: 0, z: 0 });
  await T.frames(2);
  const e = p.eye(0);
  d = { x: bare.x - e.x, y: bare.y - e.y, z: bare.z - e.z };
  await T.hold(posB, d, 6);
  g.input.held.add('fire');
  await T.hold(posB, d, 12);
  g.input.held.delete('fire');
  await T.hold(posB, d, 6);
  out.beside = { b: !!pair().b, holes: g.world.erase.holes };

  // a peer's stroke names the mouths it took; those go, and nonsense is ignored
  g._remoteOpen('nobody', { sid: 7, kp: [[me, 'b'], 'junk', ['x']] });
  out.byPeer = { b: !!pair().b };
  return out;
});

// ---------------------------------------------- a mark rides its platform
R.ride = await page.evaluate(async () => {
  const g = window.game, T = window.T, p = g.player;
  g.portals.clear();
  g.world.eraseClear();
  const m = g.world.movers.find(q => Math.abs(q.p0.z - 55) < 0.1 && Math.abs(q.p1.z - 55) < 0.1);
  if (!m) return { noShuttle: true };
  const centre = () => ({ ...m.erase.shift });
  const pos = { x: 0, y: 0.02, z: 47 };
  const ray = (from, dir) => +g.world.raycast(from, dir, 60).toFixed(2);
  await T.whiteOut();
  // put the shuttle's middle a metre short of us, heading +x at 5 m/s
  m.at = 0.5 - 1 / m.dist; m.dir = 1;
  T.pin(pos, { x: 0, y: 0, z: 1 });
  await T.frames(2);
  const eye = p.eye(0);
  const face = m.shape.min.z;                                 // its near side
  const spot = { x: 0, y: 0.8, z: face };
  const d = { x: spot.x - eye.x, y: spot.y - eye.y, z: spot.z - eye.z };
  const dl = Math.hypot(d.x, d.y, d.z), dn = { x: d.x / dl, y: d.y / dl, z: d.z / dl };
  const out = { setupRay: ray(eye, dn), setupExpect: +dl.toFixed(2) };
  await T.hold(pos, d, 4);
  g.input.held.add('fire');
  await T.frames(3);
  const at0 = centre();                                       // about where it was painted
  const stamp = m.erase.list[0];
  out.stamps = { level: g.world.erase.list.length, shuttle: m.erase.list.length };
  if (!stamp) { g.input.held.delete('fire'); return out; }
  // the marked spot of the shuttle, in the shuttle's own frame: where the stamp's
  // axis meets its near face
  const k = (-(m.shape.max.z - m.shape.min.z) / 2 - stamp.o.z) / stamp.a.z;
  const mark = { x: stamp.o.x + stamp.a.x * k, y: stamp.o.y + stamp.a.y * k, z: stamp.o.z + stamp.a.z * k };
  const markNow = () => { const c = centre(); return { x: mark.x + c.x, y: mark.y + c.y, z: mark.z + c.z }; };
  const first = markNow();                                    // the world point it was put on
  // keep holding, aim unmoved, while the shuttle carries the dot along
  for (let i = 0; i < 30; i++) { T.pin(pos, d); await T.sleep(16); }
  const now = markNow();
  out.travelled = +(now.x - first.x).toFixed(2);
  out.paint = { onTheMark: T.under(now), whereItWasPut: T.under(first), stamps: m.erase.list.length };
  g.input.held.delete('fire');
  await T.frames(3);
  // a bullet along the stamp's own line, at the mark and at where it was first put
  const along = stamp.a, back = q => ({ x: q.x - along.x * 3, y: q.y - along.y * 3, z: q.z - along.z * 3 });
  const here = markNow();
  out.holes = { shuttle: m.erase.holes, level: g.world.erase.holes };
  out.bullet = { throughTheMark: ray(back(here), along), whereItWasPut: ray(back(first), along),
                 movedSince: +(here.x - first.x).toFixed(2) };
  // and it pops with the rest, five seconds on
  await T.sleep(5300);
  const later = markNow();
  out.afterPop = { holes: m.erase.holes, bullet: ray(back(later), along) };
  return out;
});

const fail = [];
const must = (cond, msg) => { if (!cond) fail.push(msg); };
must(R.wall, 'the cover wall was not found');
{
  const r = R.ring;
  must(r.facingAway > 0.1, 'the setup is wrong: the camera is not facing away from the wall: ' + r.facingAway);
  must(r.control < r.fixed / 10, `the control did not reproduce the report: the ring shows even in the depth sort (${r.control} px)`);
  must(r.fixed > 400, `the border is gone when looking away from the mouth (${r.fixed} px, control ${r.control})`);
  must(r.fromFront > 400, `the border is missing from the front (${r.fromFront} px)`);
}
{
  const r = R.take;
  must(r.before.a && r.before.b && r.before.pixel < 235, 'setup: the mouth is not there, or already white: ' + JSON.stringify(r.before));
  must(r.painting.stamps > 0 && r.painting.holes === 0, 'holding fire did not paint: ' + JSON.stringify(r.painting));
  must(r.painting.a && r.painting.b, 'paint alone removed a portal; it should go when the stroke is let go');
  must(r.painting.pixel > 245, `paint over a mouth does not show white on it (${r.painting.pixel})`);
  must(!r.released.a, 'the portal the stroke went over is still there');
  must(r.released.b, 'the other portal went too');
  must(r.released.links === 0, 'a link survives with one mouth gone');
  must(r.released.sent.length === 1 && JSON.stringify(r.released.sent[0]).endsWith('"a"]]') && r.released.sent[0].length === 1,
       'the peers were not told which mouth went: ' + JSON.stringify(r.released.sent));
  must(r.beside.b && r.beside.holes > 0, 'a stroke beside a mouth took it (or made no hole): ' + JSON.stringify(r.beside));
  must(!r.byPeer.b, "a peer's stroke did not take the mouth it named");
}
{
  const r = R.ride;
  must(!r.noShuttle, 'the north shuttle was not found');
  if (!r.noShuttle) {
    must(Math.abs(r.setupRay - r.setupExpect) < 0.3, `setup: the aim does not land on the shuttle (${r.setupRay} vs ${r.setupExpect})`);
    must(r.stamps && r.stamps.level > 0 && r.stamps.shuttle > 0, 'no stamp on the shuttle: ' + JSON.stringify(r.stamps));
    must(r.travelled > 1.2, `the shuttle did not move during the hold (${r.travelled} m)`);
    must(r.paint && r.paint.onTheMark > 245, `the white is not on the marked spot of the shuttle (${r.paint && r.paint.onTheMark})`);
    must(r.paint && r.paint.whereItWasPut < 235, `the white stayed where it was painted (${r.paint && r.paint.whereItWasPut})`);
    must(r.holes && r.holes.shuttle > 0, 'letting go made no hole in the shuttle');
    must(r.bullet && r.bullet.throughTheMark > 7, `a bullet is stopped at the mark (${r.bullet && r.bullet.throughTheMark} m)`);
    must(r.bullet && r.bullet.whereItWasPut < 4, `a bullet goes through where the mark was first put (${r.bullet && r.bullet.whereItWasPut} m)`);
    must(r.afterPop && r.afterPop.holes === 0 && r.afterPop.bullet < 4, 'the hole in the shuttle did not pop: ' + JSON.stringify(r.afterPop));
  }
}
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R, null, 1));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ')
  : 'PASS: the border survives looking away, a stroke takes the portal it crosses, and a mark rides its platform');
await browser.close();
process.exit(fail.length ? 1 : 0);
