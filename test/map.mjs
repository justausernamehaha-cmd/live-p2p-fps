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
  const edge = span - 1;
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

  return {
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
if (!R.spawnsOnGround) fail.push('a spawn point has nothing under it');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: the whole floor is standable and every spawn is clear');
await browser.close();
process.exit(fail.length ? 1 : 0);
