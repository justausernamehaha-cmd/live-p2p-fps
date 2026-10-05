// Two mouths facing each other are a corridor: each shows the other, and in it
// itself again, and again.
//
// A mouth seen inside its own view used to show last frame's picture at the
// same place on screen, which is not what is there: the next one in must be
// drawn from a camera carried through the portal twice, the one after from
// three trips, and so on until it is too small to matter.
//
// Independent truth: a small magenta block stands beside the line between the
// two mouths, 0.6 m off it. Looking down the corridor it must appear once per
// trip through, and the k-th copy is k times as far away, so it sits 1/k as far
// from the middle of the picture. That is perspective, not anything the game
// computes. The control turns the far mouth to face away: no corridor, one view.
//
// Then the same corridor with someone else's pair in the middle of it: my far
// mouth hangs in the air looking at theirs, and their far mouth is where mine
// was. The block must still be there, now two mouths in, at the distance the
// whole trip adds up to.
//
//   ./serve.sh 8080 &   then   node test/recursion.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({ viewport: { width: 1200, height: 750 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#nameinput', 'me');
await page.fill('#roominput', 'recursion-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
  const THREE = await import('three');
  const g = window.game, p = g.player, sleep = ms => new Promise(f => setTimeout(f, ms));
  const wall = g.world.boxes.find(b => b.mover === undefined && b.min.y === 0 &&
    Math.abs(b.max.y - 2.4) < 1e-6 && b.max.z - b.min.z > 20 && b.max.x - b.min.x < 1.5 && b.min.x > 40);
  if (!wall) return { noWall: true };
  const X = wall.min.x, Z = (wall.min.z + wall.max.z) / 2, GAP = 6;
  g.portals.selfView = null;               // no body: it would stand in front of every copy
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12),
    new THREE.MeshBasicMaterial({ color: 0xff00ff }));
  marker.position.set(X - GAP / 2, 1.0, Z + 0.6);
  g.scene.add(marker);

  // A on the wall, B hung in the air GAP in front of it, facing it or facing away
  const lay = facing => {
    g.portals.clear();
    const a = g.portals.place('me', 'a', { c: { x: X, y: 1.0, z: Z }, n: { x: -1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    g.portals.place('me', 'b', { c: { x: X - GAP, y: 1.0, z: Z }, n: { x: facing ? 1 : -1, y: 0, z: 0 },
      u: { x: 0, y: 0, z: facing ? -1 : 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
    return a;
  };
  // half way between, looking at A
  const hold = async () => {
    for (let i = 0; i < 25; i++) {
      p.pos = { x: X - GAP / 2, y: 0.02, z: Z }; p.vel = { x: 0, y: 0, z: 0 };
      p.up = { x: 0, y: 1, z: 0 }; p.yaw = Math.atan2(-1, 0); p.pitch = 0; p.crouchT = 0;
      await sleep(16);
    }
  };
  /** Where the block's copies are in A's picture: the middle of each run of
   *  magenta columns, as a distance in pixels from the middle of the picture. */
  const copies = a => {
    const t = a.target, buf = new Uint8Array(t.width * t.height * 4);
    g.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
    const cols = new Array(t.width).fill(false);
    // only the rows about the middle, where every copy down a corridor is (the
    // block seen directly out of a mouth 7 m up is far below them)
    for (let i = 0; i < buf.length; i += 4) {
      if (Math.abs(Math.floor(i / 4 / t.width) - t.height / 2) > 40) continue;
      if (buf[i] > 140 && buf[i + 2] > 140 && buf[i + 1] < 100) cols[(i / 4) % t.width] = true;
    }
    const runs = [];
    for (let x = 0, from = -1; x <= t.width; x++) {
      if (x < t.width && cols[x]) { if (from < 0) from = x; continue; }
      if (from >= 0) { runs.push(Math.abs((from + x - 1) / 2 - (t.width - 1) / 2)); from = -1; }
    }
    return runs.sort((m, n) => n - m).map(v => +v.toFixed(1));
  };
  const out = {};
  const a = lay(true);
  await hold();
  out.copies = copies(a);
  out.renders = g.portals.renders;
  // A shot down the corridor goes round as often as its range lets it, the
  // tracer has a leg for every trip, and each leg starts where the last one
  // ended, carried through: same height, same place across the mouth.
  {
    const eye = new THREE.Vector3(X - GAP / 2, 1.2, Z + 0.2);
    const shot = g._raycast(eye, new THREE.Vector3(1, 0, 0), 60);
    const pts = shot.points;
    let joined = true;
    for (let i = 1; i + 1 < pts.length - 1; i += 2) {
      // into A at x = X, out of B at x = X - GAP (plus the 2 cm step off it)
      if (Math.abs(pts[i].x - X) > 0.01 || Math.abs(pts[i + 1].x - (X - GAP)) > 0.05 ||
          Math.abs(pts[i].y - pts[i + 1].y) > 0.01 || Math.abs(pts[i].z - pts[i + 1].z) > 0.01) joined = false;
    }
    for (const t of g.effects.tracers) { t.life = 0; t.line.visible = false; }
    g._drawTracer(eye, pts, 0xffffff);
    out.shot = { legs: pts.length / 2, travelled: +shot.dist.toFixed(1), joined,
                 drawn: g.effects.tracers.filter(t => t.life > 0).length };
    // ...and the others are told every leg, and draw every leg they are told
    const sent = [], send = g.net._send;
    g.net._send = (action, m) => sent.push(m);
    g.net.shot(eye, pts[1], 0, pts.slice(2));
    g.net._send = send;
    for (const t of g.effects.tracers) { t.life = 0; t.line.visible = false; }
    g._remoteShot('someone', sent[0]);
    out.shot.told = sent[0] && sent[0].p ? sent[0].p.length / 6 + 1 : 1;
    out.shot.peerDrew = g.effects.tracers.filter(t => t.life > 0).length;
  }
  // each trip in is drawn a little coarser than the one before
  const pool = g.portals._pool || [];
  out.widths = [a.target.width, ...[2, 3, 4].map(d => pool[d] && pool[d][0] ? pool[d][0].width : 0)];
  // What cannot be seen is not drawn. A slab between the far mouth and you hides
  // the corridor's second trip and nothing else; a slab between you and the
  // near mouth hides all of it. (Collision only: the cull asks the level.)
  const slab = x => ({ min: { x, y: 0, z: Z - 3 }, max: { x: x + 0.3, y: 6, z: Z + 3 } });
  const real = g.world.boxes;
  g.world.boxes = [...real, slab(X - GAP + 1)];
  await hold();
  out.rendersCorridorHidden = g.portals.renders;
  g.world.boxes = [...real, slab(X - 1.5)];
  g.portals.renders = -1;
  await hold();
  out.rendersMouthHidden = g.portals.renders;
  g.world.boxes = real;
  const away = lay(false);
  await hold();
  out.copiesFacingAway = copies(away);
  out.rendersFacingAway = g.portals.renders;
  // someone else's pair in the way: A -> my B, 7 m up, looking at their C 6 m
  // off; their D stands where my B stood. Eye to block is 12 m in all, the same
  // as the second copy of the plain corridor.
  g.portals.clear();
  const spec = (x, y, nx) => ({ c: { x, y, z: Z }, n: { x: nx, y: 0, z: 0 },
    u: { x: 0, y: 0, z: -nx }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  const mine = g.portals.place('me', 'a', spec(X, 1.0, -1));
  g.portals.place('me', 'b', spec(X - 24, 8.0, 1));
  g.portals.place('them', 'a', spec(X - 18, 8.0, -1));
  g.portals.place('them', 'b', spec(X - GAP, 1.0, 1));
  await hold();
  out.copiesThroughTheirs = copies(mine);
  out.rendersThroughTheirs = g.portals.renders;
  g.scene.remove(marker);
  return out;
});

const fail = [];
if (R.noWall) fail.push('the cover wall was not found');
else {
  const c = R.copies;
  if (!(c.length >= 3)) fail.push(`the corridor shows the block ${c.length} time(s), not once per trip: ${JSON.stringify(c)}`);
  else {
    // the second to the pixel; from the third in the views are coarse enough
    // for neighbouring copies to run together, so only that it is further in
    const second = c[1] / c[0], third = c[2] / c[0];
    if (!(Math.abs(second - 1 / 2) < 0.08)) fail.push(`copy 2 is ${second.toFixed(2)} as far off the middle as the first, not 1/2`);
    if (!(third > 0.15 && third < 0.42)) fail.push(`copy 3 is ${third.toFixed(2)} as far off the middle as the first, not about 1/3`);
  }
  if (!(R.renders >= 3 && R.renders <= 10)) fail.push(`${R.renders} views drawn for the corridor; the budget is 10`);
  // 60 m of range down a 6 m corridor from its middle: 3 m, then nine whole
  // trips, then 3 m of a tenth. Eleven legs.
  const sh = R.shot;
  if (sh.legs !== 11 || Math.abs(sh.travelled - 60) > 0.5) fail.push(`a 60 m shot down a 6 m corridor makes ${sh.legs} legs over ${sh.travelled} m, not 11 over 60`);
  if (!sh.joined) fail.push('a leg of the shot does not start where the last one went in');
  if (sh.drawn !== sh.legs) fail.push(`${sh.drawn} tracer legs drawn for a path of ${sh.legs}`);
  if (sh.told !== sh.legs || sh.peerDrew !== sh.legs) fail.push(`peers were told ${sh.told} legs and drew ${sh.peerDrew}, of ${sh.legs}`);
  const w = R.widths;
  if (!(w[0] > w[1] && w[1] > w[2] && w[2] > w[3] && w[3] > 0)) fail.push(`each trip in should be drawn coarser than the last: widths ${JSON.stringify(w)}`);
  if (R.rendersCorridorHidden !== 1) fail.push(`${R.rendersCorridorHidden} views drawn with the corridor's second trip behind a slab, not 1`);
  if (R.rendersMouthHidden > 0) fail.push(`${R.rendersMouthHidden} views drawn for a mouth wholly behind a slab`);
  const t = R.copiesThroughTheirs;
  if (!t.length) fail.push('the block is not seen through someone else\'s pair inside mine');
  else if (!(Math.abs(t[0] / c[0] - 0.5) < 0.08)) fail.push(`through their pair the block is ${(t[0] / c[0]).toFixed(2)} as far off the middle as the first copy, not 1/2`);
  if (R.rendersThroughTheirs > 10) fail.push(`${R.rendersThroughTheirs} views drawn; the budget is 10`);
  if (R.rendersFacingAway > 2) fail.push(`${R.rendersFacingAway} views drawn with no corridor to draw`);
}
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS: mouths in mouths are drawn, anyone\'s, one copy per trip and each where perspective puts it');
await browser.close();
process.exit(fail.length ? 1 : 0);
