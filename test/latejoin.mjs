// Someone who joins later gets the portals that were already there, and it is
// their colours that give way, not the colours of whoever was there first.
//
// Two real pages over the real relays. The first makes the room, places both of
// its mouths and notes its colours; only then does the second join. Portals are
// announced when they are placed, so nothing used to tell the second about
// them: it could not see them or go through them. And colours used to be dealt
// again over the whole room at every join, so the first player's changed.
//
//   ./serve.sh 8080 &   then   node test/latejoin.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
const room = 'latejoin-' + Date.now();
const errs = [];
const open = async (name) => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(name + ': ' + e.message));
  await p.goto(URL);
  await p.waitForFunction(() => window.__paStarted, { timeout: 25000 });
  await p.fill('#nameinput', name);
  await p.fill('#roominput', room);
  return p;
};
const colours = page => page.evaluate(() => {
  const g = window.game, f = g.portals;
  const out = { me: f.selfId, hue: f.myHue, mine: [f.colorFor(f.selfId, 'a'), f.colorFor(f.selfId, 'b')], others: {} };
  for (const [id, r] of g.remotes) out.others[id] = { hue: r.portalHue, pair: [f.colorFor(id, 'a'), f.colorFor(id, 'b')] };
  return out;
});

const R = {};
const A = await open('first');
await A.evaluate(() => document.getElementById('playbtn').click());
await A.waitForFunction(() => window.game.running, { timeout: 30000 });
R.placed = await A.evaluate(() => {
  const g = window.game, f = g.portals;
  const spec = z => ({ c: { x: 43.5, y: 1.0, z }, n: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 }, mover: -1 });
  f.place(f.selfId, 'a', spec(-3)); f.place(f.selfId, 'b', spec(3));
  return [-3, 3];
});
R.firstAlone = await colours(A);

const B = await open('second');
await B.evaluate(() => document.getElementById('playbtn').click());
await B.waitForFunction(() => window.game.running, { timeout: 40000 });
// both mouths of the first player, on the second player's screen
R.secondGotThem = await B.waitForFunction(() => {
  const g = window.game;
  return [...g.portals.pairs].some(([id, p]) => id !== g.portals.selfId && p.a && p.b);
}, { timeout: 20000 }).then(() => true).catch(() => false);
await A.waitForFunction(() => [...window.game.remotes.values()].some(r => Number.isFinite(r.portalHue)), { timeout: 20000 }).catch(() => {});
await B.waitForTimeout(1500);                  // let the colours settle both ways
R.theirs = await B.evaluate(() => {
  const g = window.game;
  const e = [...g.portals.pairs].find(([id, p]) => id !== g.portals.selfId && p.a && p.b);
  return e ? { a: e[1].a.c.z, b: e[1].b.c.z, links: g.portals.links().length } : null;
});
R.firstAfter = await colours(A);
R.second = await colours(B);

const gap = (a, b) => { const d = (((a - b) % 180) + 180) % 180; return Math.min(d, 180 - d); };
const fail = [];
if (!R.secondGotThem) fail.push('the second player was never told about the portals already in the room');
else {
  if (R.theirs.a !== -3 || R.theirs.b !== 3) fail.push('the portals arrived somewhere else: ' + JSON.stringify(R.theirs));
  if (R.theirs.links !== 2) fail.push(`the second player can go through ${R.theirs.links} of the 2 ways`);
}
if (String(R.firstAfter.mine) !== String(R.firstAlone.mine)) fail.push(`the first player's colours changed when someone joined: ${R.firstAlone.mine} -> ${R.firstAfter.mine}`);
if (!(gap(R.second.hue, R.firstAfter.hue) >= 30)) fail.push(`the two pairs are ${gap(R.second.hue, R.firstAfter.hue)} degrees apart, not 30 or more`);
const seenByFirst = R.firstAfter.others[R.second.me], seenBySecond = R.second.others[R.firstAfter.me];
if (!seenByFirst || String(seenByFirst.pair) !== String(R.second.mine)) fail.push('the first player does not see the second in the colours the second chose: ' + JSON.stringify(seenByFirst));
if (!seenBySecond || String(seenBySecond.pair) !== String(R.firstAfter.mine)) fail.push('the second player does not see the first in the first\'s own colours: ' + JSON.stringify(seenBySecond));
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(JSON.stringify(R));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : 'PASS: a late joiner gets the portals already there, and takes colours around the ones already taken');
await browser.close();
process.exit(fail.length ? 1 : 0);
