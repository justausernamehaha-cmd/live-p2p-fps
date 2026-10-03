// The gun in your hands and the gun everyone else sees you holding are the same
// model — the one you see in your own hands — for every weapon.
//
// Compared mesh by mesh: box size, position and colour, first person against the
// gun on a body (the same body your peers draw). And it must be the in-hand design
// (its 0.09 x 0.11 x 0.5 body), not the old third-person one.
//
//   ./serve.sh 8080 &   then   node test/gunmodel.mjs
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
await page.fill('#nameinput', 'gun');
await page.fill('#roominput', 'gun-' + Date.now());
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(800);

const R = await page.evaluate(async () => {
  const g = window.game;
  const shape = group => group.children.filter(m => m.isMesh).map(m => {
    const q = m.geometry.parameters;
    return [q.width * m.scale.x, q.height * m.scale.y, q.depth * m.scale.z,
            m.position.x, m.position.y, m.position.z, m.material.color.getHex()]
      .map(v => typeof v === 'number' && v < 1 ? +v.toFixed(4) : v);
  });
  const out = [];
  for (let i = 0; i < 5; i++) {
    // the way a player switches: the portal gun's accents are painted on the way
    if (g.loadout.index !== i) g._switch(g.loadout.switchTo(i, 0));
    g.selfAvatar.update(g.player, g.loadout.index);
    out.push({ i, hand: shape(g.viewmodel.gun), body: shape(g.selfAvatar.parts.gun) });
  }
  return out;
});

const fail = [];
for (const r of R) {
  if (!r.hand.length) fail.push(`weapon ${r.i}: no gun in the hand`);
  if (JSON.stringify(r.hand) !== JSON.stringify(r.body))
    fail.push(`weapon ${r.i}: the hand and the body differ\n    hand ${JSON.stringify(r.hand)}\n    body ${JSON.stringify(r.body)}`);
  if (!r.hand.some(m => m[0] === 0.09 && m[1] === 0.11 && m[2] === 0.5))
    fail.push(`weapon ${r.i}: not the in-hand design (no 0.09 x 0.11 x 0.5 body)`);
}
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '));
console.log(fail.length ? 'FAIL\n  ' + fail.join('\n  ') : `PASS: all ${R.length} guns are the in-hand model, in the hand and on the body`);
await browser.close();
process.exit(fail.length ? 1 : 0);
