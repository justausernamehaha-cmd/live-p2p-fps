// Arena sanity: every place you can stand must let you stand up.
//
// This is the class of fault that hand-checking missed the first time - a
// rooftop with a walkable surface underneath it and only 0.7m of headroom, which
// traps a 1.8m player. It scans the whole floor analytically rather than by
// walking, so doubling the map size costs nothing to re-check.
//
//   ./serve.sh 8080 &   then   node test/map.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);

const R = await page.evaluate(() => {
  const g = window.game;
  const boxes = g.world.boxes;
  const R = 0.17, H = 1.8, CROUCH = 1.15;

  const span = boxes.reduce((a, b) => Math.max(a, b.max.x, b.max.z), 0);
  const overlaps = (x, y, z, h) => {
    const min = { x: x - R, y, z: z - R }, max = { x: x + R, y: y + h, z: z + R };
    for (const b of boxes) {
      if (min.x < b.max.x && max.x > b.min.x && min.y < b.max.y &&
          max.y > b.min.y && min.z < b.max.z && max.z > b.min.z) return true;
    }
    return false;
  };
  // highest surface under the given point that a player could be standing on
  const supportAt = (x, z) => {
    let best = null;
    for (const b of boxes) {
      if (x - R < b.max.x && x + R > b.min.x && z - R < b.max.z && z + R > b.min.z) {
        if (b.max.y <= 12 && (best === null || b.max.y > best)) best = b.max.y;
      }
    }
    return best;
  };

  const trapped = [], crouchOnly = [], noFloor = [];
  const step = 2;
  // Inside the room, not on top of it. The arena is a closed box now, so the
  // tops of the walls are the far side of the ceiling and no place a player can
  // be; scanning them would report the lid as a headroom trap. The inner faces
  // are half a metre in from the outer ones.
  const edge = span - 1.5;
  for (let x = -edge; x <= edge; x += step) {
    for (let z = -edge; z <= edge; z += step) {
      const y = supportAt(x, z);
      if (y === null) { noFloor.push([x, z]); continue; }
      if (!overlaps(x, y + 0.02, z, H)) continue;            // room to stand
      if (!overlaps(x, y + 0.02, z, CROUCH)) crouchOnly.push([x, z, +y.toFixed(1)]);
      else trapped.push([x, z, +y.toFixed(1)]);
    }
  }

  // spawns must be clear and on the ground
  const badSpawns = g.world.spawns.filter(s => overlaps(s.x, s.y, s.z, H));
  const spawnFloors = g.world.spawns.map(s => supportAt(s.x, s.z));

  // ---------------------------------------- every corner fillet faces its wall
  // A fillet is a wedge that is thickest where it meets the wall and tapers to
  // nothing as it reaches into the room — on the floor and on the ceiling
  // alike. Two of the four ceiling ones were built backwards, thick out in the
  // room and thin at the wall, because turning a wedge over was done as a half
  // turn about the world's y and that reverses the way it climbs as well as
  // which way up it is. Measured, not read off the rotation: the solid's own
  // thickness where it meets the surface against where it ends.
  const solids = g.world.solids || [];
  const fillets = solids.filter(s =>
    Math.max(s.max.x - s.min.x, s.max.z - s.min.z) > 100 && s.max.y - s.min.y <= 1.7);
  const sliceAt = (s, y) => {
    const alongX = (s.max.x - s.min.x) < 5;    // which way the wedge is thin
    const a = alongX ? 'x' : 'z';
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t <= 400; t++) {
      const v = s.min[a] + (s.max[a] - s.min[a]) * (t / 400);
      const pt = { x: alongX ? v : 0, y, z: alongX ? 0 : v };
      let inside = true;
      for (const pl of s.planes) {
        if (pl.nx * pt.x + pl.ny * pt.y + pl.nz * pt.z - pl.d > 1e-6) { inside = false; break; }
      }
      if (inside) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    return lo === Infinity ? null : { lo, hi, axis: a };
  };
  const backwards = [];
  for (const s of fillets) {
    const ceiling = s.min.y > 6;
    const wide = sliceAt(s, ceiling ? s.max.y - 0.05 : s.min.y + 0.05);
    const tip = sliceAt(s, ceiling ? s.min.y + 0.05 : s.max.y - 0.05);
    // The wall face is whichever end of the wedge's own box is further out.
    const wall = wide && (Math.abs(s.min[wide.axis]) > Math.abs(s.max[wide.axis])
      ? s.min[wide.axis] : s.max[wide.axis]);
    const ok = wide && tip &&
      (wide.hi - wide.lo) > 1.4 &&                       // thick where it joins
      (tip.hi - tip.lo) < 0.2 &&                         // and tapering to nothing
      // ...and the last sliver of it is against the wall, not out in the room.
      // This is the half the reversed ceiling fillets got wrong: they were the
      // right shape, hung the right way up, and pointing the wrong way.
      Math.min(Math.abs(tip.lo - wall), Math.abs(tip.hi - wall)) < 0.12;
    // ...and the two faces that are *not* the incline sit flat against the
    // surfaces the wedge joins, with no gap behind it: the vertical one on the
    // wall's inner face, the horizontal one on the floor or the ceiling.
    const alongX = (s.max.x - s.min.x) < 5;
    const a = alongX ? 'x' : 'z';
    const wallFace = Math.abs(s.min[a]) > Math.abs(s.max[a]) ? s.min[a] : s.max[a];
    // the walls are 1 m thick and `span` is their outside, so the room's own
    // inner face is one metre in
    const roomFace = span - 1;
    const flatOnTheWall = Math.abs(Math.abs(wallFace) - roomFace) < 1e-6;
    const flatOnTheSurface = ceiling ? Math.abs(s.max.y - 12) < 1e-6 : Math.abs(s.min.y) < 1e-6;
    if (!ok || !flatOnTheWall || !flatOnTheSurface) {
      backwards.push({
        flatOnTheWall, flatOnTheSurface, wallFace: +wallFace.toFixed(2),
        ceiling, y: +s.min.y.toFixed(1), wall: wall === undefined ? null : +wall.toFixed(1),
        wideAt: wide ? [+wide.lo.toFixed(2), +wide.hi.toFixed(2)] : null,
        tipAt: tip ? [+tip.lo.toFixed(2), +tip.hi.toFixed(2)] : null
      });
    }
  }

  return {
    filletCount: fillets.length,
    filletsBackwards: backwards,
    arenaSpan: +(span * 2).toFixed(0),
    boxCount: boxes.length,
    sampled: Math.pow(Math.floor((2 * edge) / step) + 1, 2),
    trapped, crouchOnly: crouchOnly.length, noFloor: noFloor.length,
    badSpawns: badSpawns.length,
    spawnsOnGround: spawnFloors.every(f => f !== null),
    spawnRing: g.world.spawns.map(s => +Math.hypot(s.x, s.z).toFixed(0))[0]
  };
});

const fail = [];
if (R.trapped.length) fail.push(`${R.trapped.length} spots where a player cannot even crouch: ${JSON.stringify(R.trapped.slice(0, 6))}`);
if (R.noFloor.length) fail.push(`${R.noFloor.length} sampled spots have no floor at all`);
if (R.badSpawns) fail.push(`${R.badSpawns} spawn points are inside geometry`);
if (R.filletCount !== 8) fail.push(`expected 8 corner fillets, found ${R.filletCount}`);
if (R.filletsBackwards.length)
  fail.push(`${R.filletsBackwards.length} corner fillets are built backwards: ${JSON.stringify(R.filletsBackwards)}`);
if (!R.spawnsOnGround) fail.push('a spawn point has nothing under it');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: the whole floor is standable and every spawn is clear');
await browser.close();
process.exit(fail.length ? 1 : 0);
