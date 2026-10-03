// Falling back into the mouth you came out of, drifting toward its rim.
//
// Jump up into a ceiling mouth whose partner is in the floor and you come out of
// the floor head first, rising slowly; fall back before you are clear and you
// must go back through. The hole is cut wider than the oval (so a body can brush
// the rim), and a body drifting sideways in it came to rest with its centre 3 cm
// outside the oval — where the crossing test said "wall, not hole" — and sank out
// of the bottom of the map: out of bounds, dead. Found by a probe throwing
// players through 250 random portal pairs; 9 deaths, every one this.
//
// Independent truth: the body is never out of the room and never dies, and the
// fall back is handed over (two traversals, not one).
//
//   ./serve.sh 8080 &   then   node test/rimfall.mjs
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
await page.fill('#nameinput', 'rim');
await page.fill('#roominput', 'rim-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
  const g = window.game, p = g.player, sleep = ms => new Promise(f => setTimeout(f, ms));
  let died = null;
  const real = g._selfDeath.bind(g);
  g._selfDeath = (by, label) => { died = label; real(by, label); };
  const A = { c: { x: -38, y: 12, z: 40 }, n: { x: 0, y: -1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 }, mover: -1 };
  const B = { c: { x: -9, y: 0, z: -40 }, n: { x: 0, y: 1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 }, mover: -1 };
  const out = [];
  for (const [name, dx, dz] of [['+x', 1, 0], ['-x', -1, 0], ['+z', 0, 1], ['-z', 0, -1]]) {
    for (const drift of [1.2, 2.5]) {
      g.portals.clear();
      g.portals.place('me', 'a', A);
      g.portals.place('me', 'b', B);
      p.spawn({ x: A.c.x, y: 0.05, z: A.c.z });
      p.protectedUntil = 0;
      await sleep(40);
      p.up = { x: 0, y: 1, z: 0 }; p.upFrom = null; p.upBlend = 0;
      p.crouchT = 0; p._wasAt = new Map(); p._inMouth = null; p.straddling = null;
      p.pos = { x: A.c.x, y: 12 - 1.6 - 0.3, z: A.c.z };
      p.vel = { x: 0, y: 5.5, z: 0 };            // arrives rising at about 3 m/s
      died = null;
      const pc = p.portalCount;
      let pushed = false, outOfRoom = 0, lastT = performance.now();
      const bad = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 2500 && !died) {
        await sleep(16);
        if (!pushed && p.portalCount > pc) {
          pushed = true;
          p.vel.x = dx * drift; p.vel.z = dz * drift;
        }
        if (pushed && p.portalCount === pc + 1) { p.vel.x = dx * drift; p.vel.z = dz * drift; }
        // the eye, not the feet: out of a floor head first, the feet are rightly
        // 1.6 m down the hole
        const q = p._eyePhys();
        if (Math.abs(q.x) > 59.6 || Math.abs(q.z) > 59.6 || q.y < -0.3 || q.y > 12.3) {
          outOfRoom++;
          if (bad.length < 4) {
            const d = { x: q.x - B.c.x, y: q.y - B.c.y, z: q.z - B.c.z };
            bad.push({ eyeB: [d.x * B.u.x + d.z * B.u.z, d.x * B.v.x + d.z * B.v.z, d.y].map(v => +v.toFixed(2)),
                       inMouth: p.straddling ? (p.straddling.link.from.side) : '-', crossings: p.portalCount - pc,
                       dt: +(performance.now() - lastT).toFixed(0) });
          }
        }
        lastT = performance.now();
      }
      out.push({ name, drift, crossings: p.portalCount - pc, died, outOfRoom, ...(bad.length ? { bad } : {}) });
    }
  }
  return out;
});

const fail = [];
for (const r of R) {
  const tag = `${r.name} at ${r.drift} m/s`;
  if (r.died) fail.push(`${tag}: died (${r.died})`);
  if (r.outOfRoom) fail.push(`${tag}: out of the room for ${r.outOfRoom} frames`);
  if (r.crossings < 2) fail.push(`${tag}: not handed back through (${r.crossings} traversal)`);
}
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS: falling back into a mouth near its rim goes back through');
await browser.close();
process.exit(fail.length ? 1 : 0);
