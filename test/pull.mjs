// The portal pull: a setting from 0 to 1. Around each mouth is an egg, the oval
// grown by twice the setting and as deep as it is wide; a body that comes into
// it is drawn through the mouth whatever it was doing.
//
// Independent truth is where the body ends up: in front of the OTHER mouth, 12 m
// along the wall, having been handed over exactly once. Each case has its
// opposite: the same start with the setting at 0, a start just outside the egg,
// and a body flying AWAY from the mouth at 40 m/s, which nothing else in the
// game would bring back.
//
//   ./serve.sh 8080 &   then   node test/pull.mjs
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
await page.fill('#roominput', 'pull-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
  const g = window.game, p = g.player, sleep = ms => new Promise(f => setTimeout(f, ms));
  const wall = g.world.boxes.find(b => b.mover === undefined && b.min.y === 0 &&
    Math.abs(b.max.y - 2.4) < 1e-6 && b.max.z - b.min.z > 20 && b.max.x - b.min.x < 1.5 && b.min.x > 40);
  if (!wall) return { noWall: true };
  const X = wall.min.x, zm = (wall.min.z + wall.max.z) / 2, ZA = zm - 6, ZB = zm + 6;
  const at = z => ({ c: { x: X, y: 1.0, z }, n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  g.portals.clear();
  g.portals.place('me', 'a', at(ZA));
  g.portals.place('me', 'b', at(ZB));

  const slider = document.getElementById('pullslider');
  const set = v => { slider.value = v; slider.dispatchEvent(new Event('input', { bubbles: true })); };
  const out = { hasSlider: !!slider, range: [slider.min, slider.max] };

  /** Stand well clear, then appear `d` in front of A and `off` along the wall
   *  with velocity `vel`, and see where a second later finds the body. */
  const trial = async (d, off, vel = { x: 0, y: 0, z: 0 }) => {
    p.pos = { x: X - 8, y: 0.02, z: ZA }; p.vel = { x: 0, y: 0, z: 0 }; p.up = { x: 0, y: 1, z: 0 };
    await sleep(150);
    const before = p.portalCount;
    p.pos = { x: X - d, y: 0.02, z: ZA + off }; p.vel = { ...vel };
    await sleep(1000);
    return { crossings: p.portalCount - before, nearB: Math.abs(p.pos.z - ZB) < 3 && p.pos.x < X,
             alive: p.alive, at: [+p.pos.x.toFixed(2), +p.pos.z.toFixed(2)] };
  };

  set(0);
  out.offValue = p.suck; out.offLabel = document.getElementById('pullval').textContent;
  out.off = await trial(1.0, 0.8);
  set(1);
  out.onValue = p.suck; out.saved = localStorage.getItem('pa.pull');
  // at 1 the egg is 1.36 across and deep: (0.8, 1.0) is in it, (1.2, 1.2) is not
  out.inside = await trial(1.0, 0.8);
  out.outside = await trial(1.2, 1.2);
  out.fleeing = await trial(1.0, 0.8, { x: -40, y: 0, z: 0 });
  // at 0.5 the egg is the mouth's own size: 0.68 across and deep
  set(0.5);
  out.halfInside = await trial(0.4, 0.3);
  out.halfOutside = await trial(1.0, 0.8);
  set(0);
  return out;
});

const fail = [];
if (R.noWall) fail.push('the cover wall was not found');
else {
  const went = r => r.crossings === 1 && r.nearB && r.alive;
  const stayed = r => r.crossings === 0 && !r.nearB && r.alive;
  if (!R.hasSlider || R.range[0] !== '0' || R.range[1] !== '1') fail.push('no 0-to-1 slider in the settings: ' + JSON.stringify(R.range));
  if (R.offValue !== 0 || R.offLabel !== 'off') fail.push(`0 is not off: ${R.offValue} "${R.offLabel}"`);
  if (R.onValue !== 1 || R.saved !== '1') fail.push(`the slider did not set and save 1: ${R.onValue}, saved ${R.saved}`);
  if (!stayed(R.off)) fail.push('with the pull off a body near a mouth still went through: ' + JSON.stringify(R.off));
  if (!went(R.inside)) fail.push('a body inside the reach was not drawn through once: ' + JSON.stringify(R.inside));
  if (!stayed(R.outside)) fail.push('a body outside the reach was drawn in: ' + JSON.stringify(R.outside));
  if (!went(R.fleeing)) fail.push('a body flying away at 40 m/s was not drawn through: ' + JSON.stringify(R.fleeing));
  if (!went(R.halfInside)) fail.push('at 0.5, a body inside the smaller reach was not drawn through: ' + JSON.stringify(R.halfInside));
  if (!stayed(R.halfOutside)) fail.push('at 0.5, the reach is still as big as at 1: ' + JSON.stringify(R.halfOutside));
}
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS: the portal pull draws in what comes into its reach, once, and nothing else');
await browser.close();
process.exit(fail.length ? 1 : 0);
