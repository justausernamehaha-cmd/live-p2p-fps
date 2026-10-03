// White Out in the running game, and to a second player over the real relays.
//
//   * the reticle: 5 takes it out, the crosshair goes and a circle comes;
//   * hold and drag: the stroke is stamped as white paint — solid to bullets,
//     white on screen — and the shooter cannot move while holding; let go and
//     it is a hole, bullets go through, the shooter walks again;
//   * the pop: the hole stays whole for five seconds and then is gone at once;
//   * a real hole: a player walks through a slot painted in the cover wall,
//     against the same walk with no slot, which the wall stops;
//   * out of bounds: falling out of the map through a hole is death, instantly;
//   * the kill: a stroke painted over the other page kills nobody until it is
//     let go, a wide one leaves them alive, the gun refuses while recharging,
//     and a release over them — through the centre block — kills them on their
//     own page.
//
//   ./serve.sh 8080 &   then   node test/whiteout.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const ctx = await browser.newContext({ viewport: { width: 800, height: 520 } });
const room = 'whiteout-' + Date.now();
const errs = [];
const R = {};
const fail = [];
const must = (cond, msg) => { if (!cond) fail.push(msg); };

const open = async name => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(name + ': ' + e.message));
  await p.goto(URL);
  await p.waitForFunction(() => window.__paStarted, { timeout: 25000 });
  await p.fill('#nameinput', name);
  await p.fill('#roominput', room);
  return p;
};

const A = await open('alpha');
await A.evaluate(() => document.getElementById('playbtn').click());
await A.waitForFunction(() => window.game.running, { timeout: 30000 });
await A.waitForTimeout(800);

// ------------------------------------------------------------------ reticle
R.reticle = await A.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const vis = id => !document.getElementById(id).classList.contains('hidden');
  const out = { rifle: { cross: vis('crosshair'), ring: vis('erasering') } };
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit5', bubbles: true }));
  await sleep(60);
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit5', bubbles: true }));
  await sleep(200);
  const ring = document.getElementById('erasering').getBoundingClientRect();
  out.whiteout = {
    index: g.loadout.index, cross: vis('crosshair'), ring: vis('erasering'),
    diameter: +ring.width.toFixed(1), name: document.getElementById('weaponname').textContent,
    mag: document.getElementById('mag').textContent
  };
  out.expectDiameter = +(2 * Math.tan(0.052) / Math.tan(g.camera.fov * Math.PI / 360) *
                         g.canvas.clientHeight / 2).toFixed(1);
  return out;
});
{
  const r = R.reticle;
  must(r.rifle.cross && !r.rifle.ring, 'the rifle does not show the plain crosshair');
  must(r.whiteout.index === 4, '5 did not select White Out');
  must(!r.whiteout.cross && r.whiteout.ring, 'White Out still shows the crosshair, or no circle');
  must(Math.abs(r.whiteout.diameter - r.expectDiameter) < 2,
       `the circle is ${r.whiteout.diameter}px, expected ${r.expectDiameter}px`);
  must(r.whiteout.mag === 'READY', 'the HUD does not say READY: ' + r.whiteout.mag);
}

// ------------------------------------------- hold and drag, release, the pop
R.paint = await A.evaluate(async () => {
  const g = window.game, p = g.player, E = g.world.erase;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const mag = () => document.getElementById('mag').textContent;
  const keys = (...on) => { g.input.held.clear(); for (const k of on) g.input.held.add(k); g.input._recalcKeys(); };
  // pixel under a world point, rendered and read back in one task
  const read = world => {
    g._camera(0);
    g.renderer.setRenderTarget(null);
    g.renderer.render(g.scene, g.camera);
    const v = g.camera.position.clone().set(world.x, world.y, world.z).project(g.camera);
    const gl = g.renderer.getContext();
    const x = Math.round((v.x + 1) / 2 * gl.drawingBufferWidth), y = Math.round((v.y + 1) / 2 * gl.drawingBufferHeight);
    const px = new Uint8Array(4 * 4 * 4);
    gl.readPixels(x - 2, y - 2, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0;
    for (let i = 0; i < 16; i++) s += (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    return +(s / 16).toFixed(1);
  };
  const ahead = () => +g.world.raycast({ x: 0, y: 1.67, z: -38 }, { x: 0, y: 0, z: -1 }, 200).toFixed(2);
  E.clear();
  keys();
  p.spawn({ x: 0, y: 0.05, z: -38 });                 // 5.5 m short of the cover wall
  await sleep(400);
  p.yaw = 0; p.pitch = -0.1; p.recoil = 0; p.recoilYaw = 0;
  const onWall = { x: 0, y: 1.67, z: -43.5 };
  const out = { rayBefore: ahead(), pixelBefore: read(onWall) };

  // hold fire, drag the circle up the wall, and try to walk forward throughout
  keys('fire', 'fwd');
  const z0 = p.pos.z;
  for (let i = 0; i <= 30; i++) { p.pitch = -0.1 + i * 0.012; await sleep(30); }
  out.held = {
    stamps: E.list.length, holes: E.holes, hud: mag(),
    moved: +Math.hypot(p.pos.x, p.pos.z - z0).toFixed(3), ray: ahead(), pixel: read(onWall)
  };

  // a portal shot at the white paint explodes; one well beside it lands
  {
    const pf = g.portals, e = p.eye(0);
    const toward = (x, y, z) => { const d = { x: x - e.x, y: y - e.y, z: z - e.z }, l = Math.hypot(d.x, d.y, d.z);
                                  return { x: d.x / l, y: d.y / l, z: d.z / l }; };
    pf.clear();
    pf.fire(pf.selfId, e, toward(0, 1.67, -43.5), 'a', false, p.up);
    pf.fire(pf.selfId, e, toward(-6, 1.2, -43.5), 'b', false, p.up);
    await sleep(350);
    out.portalOnPaint = !!pf.pairs.get(pf.selfId)?.a;
    out.portalBesidePaint = !!pf.pairs.get(pf.selfId)?.b;
    pf.clear();
  }

  keys('fwd');                                       // let go of fire, keep walking
  const releasedAt = performance.now();
  await sleep(120);
  out.released = {
    holes: E.holes, paint: E.list.filter(c => !c.hole).length, ray: ahead(), hud: mag(),
    pixel: read(onWall)
  };
  const z1 = p.pos.z;
  await sleep(400);
  out.movedAfter = +Math.abs(p.pos.z - z1).toFixed(2);
  keys();

  while (performance.now() - releasedAt < 4700) await sleep(20);
  out.at47 = E.holes;
  while (E.holes && performance.now() - releasedAt < 9000) await sleep(10);
  out.poppedAfter = +((performance.now() - releasedAt) / 1000).toFixed(2);
  out.rayAfterPop = ahead();
  return out;
});
{
  const q = R.paint;
  must(Math.abs(q.rayBefore - 5.5) < 0.05, 'the cover wall is not 5.5 m ahead: ' + q.rayBefore);
  must(q.held.stamps >= 5, 'dragging did not paint a stroke: ' + q.held.stamps);
  must(q.held.holes === 0, 'the stroke was a hole before it was let go');
  must(q.held.hud === 'PAINTING', 'the HUD does not say PAINTING: ' + q.held.hud);
  must(q.held.moved < 0.05, 'the shooter moved while holding: ' + q.held.moved);
  must(Math.abs(q.held.ray - 5.5) < 0.05, 'paint let a bullet through: ' + q.held.ray);
  must(q.held.pixel > 230 && q.held.pixel > q.pixelBefore + 60,
       `the paint is not white on screen (${q.pixelBefore} -> ${q.held.pixel})`);
  must(!q.portalOnPaint, 'a portal landed on White Out paint');
  must(q.portalBesidePaint, 'the control portal beside the paint did not land, so the refusal proves nothing');
  // released, a stroke is simplified: its stamps merge into fewer holes
  must(q.released.holes >= 1 && q.released.paint === 0,
       `letting go did not turn the stroke into holes (${JSON.stringify(q.released)})`);
  must(q.released.holes < q.held.stamps,
       `the straight stroke was not simplified (${q.held.stamps} stamps -> ${q.released.holes} holes)`);
  must(q.released.ray > 20, 'a bullet did not go through the hole: ' + q.released.ray);
  must(Math.abs(q.released.pixel - q.held.pixel) > 60, 'the hole looks the same as the paint');
  must(/^\d+(\.\d)?s$/.test(q.released.hud), 'the HUD did not count the recharge down: ' + q.released.hud);
  must(q.movedAfter > 1, 'the shooter still cannot move after letting go: ' + q.movedAfter);
  must(q.at47 === q.released.holes, 'the hole shrank or closed before five seconds: ' + q.at47);
  must(q.poppedAfter >= 4.9 && q.poppedAfter <= 5.4, `the hole popped after ${q.poppedAfter}s, not five`);
  must(Math.abs(q.rayAfterPop - 5.5) < 0.05, 'the wall did not come back: ' + q.rayAfterPop);
}

// --------------------------------------------------- walking through a slot
R.slot = await A.evaluate(async () => {
  const g = window.game, p = g.player, E = g.world.erase;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  const keys = (...on) => { g.input.held.clear(); for (const k of on) g.input.held.add(k); g.input._recalcKeys(); };
  const ws = g.loadout.state[4];
  while (performance.now() / 1000 < ws.readyAt + 0.1) await sleep(50);
  E.clear();
  keys();
  const walk = async () => {
    p.spawn({ x: 0, y: 0.05, z: -41 });
    await sleep(200);
    p.yaw = 0; p.pitch = 0;
    keys('fwd');
    let minZ = Infinity;
    const end = performance.now() + 2500;
    while (performance.now() < end && p.pos.z > -44.9) { minZ = Math.min(minZ, p.pos.z); await sleep(8); }
    keys();
    minZ = Math.min(minZ, p.pos.z);
    return +minZ.toFixed(2);
  };
  const out = { blocked: await walk() };
  // paint a slot from 8.5 m back: aim at the foot of the wall, drag past head height
  p.spawn({ x: 0, y: 0.05, z: -35 });
  await sleep(300);
  p.yaw = 0; p.recoil = 0; p.recoilYaw = 0;
  const eye = p.eye(0);
  const pitchAt = y => Math.atan2(y - eye.y, 8.5);
  const lo = pitchAt(0.35), hi = pitchAt(2.3);
  p.pitch = lo;
  await sleep(50);
  keys('fire');
  for (let i = 0; i <= 25; i++) { p.pitch = lo + (hi - lo) * i / 25; await sleep(30); }
  keys();
  await sleep(150);
  out.slotHoles = E.holes;
  out.through = await walk();
  out.alive = p.alive;
  return out;
});
must(R.slot.blocked > -43.4, 'the negative control is wrong: the wall did not stop the walk (' + R.slot.blocked + ')');
must(R.slot.slotHoles >= 1, 'no slot was painted: ' + R.slot.slotHoles);
must(R.slot.through < -44.6, `the player could not walk through the painted slot (got to z=${R.slot.through})`);

// ------------------------------------------------------------ out of bounds
R.bounds = await A.evaluate(async () => {
  const g = window.game, p = g.player, E = g.world.erase;
  const sleep = ms => new Promise(f => setTimeout(f, ms));
  while (!p.alive) await sleep(50);
  E.clear();
  const spot = { x: 6, y: 0.05, z: -40 };
  p.spawn(spot);
  await sleep(300);
  const deathsBefore = p.deaths;
  E.add({ x: spot.x, y: 30, z: spot.z }, { x: 0, y: -1, z: 0 }, performance.now() / 1000);
  let diedAtY = null;
  const end = performance.now() + 4000;
  while (performance.now() < end) {
    if (!p.alive) { diedAtY = +p.pos.y.toFixed(2); break; }
    await sleep(4);
  }
  await sleep(1500);
  return {
    diedAtY, deaths: p.deaths - deathsBefore, stillDead: !p.alive,
    feed: document.getElementById('killfeed').textContent
  };
});
must(R.bounds.diedAtY !== null, 'falling out of the map through a hole did not kill');
must(R.bounds.diedAtY !== null && R.bounds.diedAtY > -3.5,
     'death was not instant on leaving the map: died at y=' + R.bounds.diedAtY);
must(R.bounds.deaths === 1, 'the death was not counted: ' + R.bounds.deaths);
must(R.bounds.stillDead, 'the player was teleported back rather than killed');
must(/out of bounds/.test(R.bounds.feed), 'the killfeed does not say out of bounds');

// --------------------------------------------------------------- the kill
const B = await open('beta');
await B.evaluate(() => document.getElementById('playbtn').click());
await B.waitForFunction(() => window.game.running, { timeout: 40000 });
await B.waitForTimeout(3400);                       // the join shield
await A.waitForFunction(() => window.game.player.alive, { timeout: 10000 });

await A.evaluate(() => { const g = window.game; g.world.erase.clear(); g.player.spawn({ x: 0, y: 0.05, z: 40 }); });
await B.evaluate(() => { const g = window.game; g.world.erase.clear(); g.player.spawn({ x: 0, y: 0.05, z: -40 }); });
await A.evaluate(() => window.game._switch(window.game.loadout.switchTo(4, performance.now() / 1000)));
await A.waitForFunction(() => [...window.game.remotes.values()].some(r =>
  !r.settling && r.alive && Math.abs(r.pos.z + 40) < 0.5), { timeout: 20000 });
await A.waitForFunction(() => performance.now() / 1000 > window.game.loadout.state[4].readyAt, { timeout: 12000 });

const aim = target => A.evaluate(tgt => {
  const g = window.game, p = g.player;
  const e = p.eye(0);
  const d = { x: tgt.x - e.x, y: tgt.y - e.y, z: tgt.z - e.z };
  const l = Math.hypot(d.x, d.y, d.z);
  const a = window.__frame.anglesIn(p.up, { x: d.x / l, y: d.y / l, z: d.z / l });
  p.yaw = a.yaw; p.pitch = a.pitch; p.recoil = 0; p.recoilYaw = 0;
  const hit = g._raycast(g.camera.position.clone().set(e.x, e.y, e.z),
                         g.camera.position.clone().set(d.x / l, d.y / l, d.z / l), 250);
  return { rifleHitsPlayer: !!hit.player };
}, target);
const hold = on => A.evaluate(on => {
  const g = window.game;
  if (on) g.input.held.add('fire'); else g.input.held.delete('fire');
}, on);
const onB = () => B.evaluate(() => ({
  alive: window.game.player.alive, holes: window.game.world.erase.holes,
  paint: window.game.world.erase.list.filter(c => !c.hole).length
}));

// a miss, eight metres to the side
R.miss = await aim({ x: 8, y: 0.95, z: -40 });
await hold(true);
await A.waitForTimeout(250);
await hold(false);
await B.waitForTimeout(1500);
R.afterMiss = await onB();

// the gun will not paint again while it recharges
await hold(true);
await A.waitForTimeout(400);
await hold(false);
await B.waitForTimeout(800);
R.duringRecharge = await onB();
R.ringCharging = await A.evaluate(() => document.getElementById('erasering').classList.contains('charging'));

// painting over them kills nobody until it is let go...
await A.waitForFunction(() => document.getElementById('mag').textContent === 'READY', { timeout: 12000 });
await B.waitForFunction(() => window.game.world.erase.holes === 0, { timeout: 12000 });
R.aim = await aim({ x: 0, y: 0.95, z: -40 });
await hold(true);
await B.waitForFunction(() => window.game.world.erase.list.length > 0, { timeout: 5000 }).catch(() => {});
await A.waitForTimeout(700);
R.whilePainting = await onB();
// ...and then does
await hold(false);
R.victimDied = await B.waitForFunction(() => !window.game.player.alive, { timeout: 5000 })
  .then(() => true).catch(() => false);
R.victim = await B.evaluate(() => ({
  hp: window.game.player.hp, feed: document.getElementById('killfeed').textContent
}));
await A.waitForFunction(() => window.game.player.kills >= 1, { timeout: 5000 }).catch(() => {});
R.shooter = await A.evaluate(() => ({
  kills: window.game.player.kills, feed: document.getElementById('killfeed').textContent
}));

must(!R.miss.rifleHitsPlayer, 'the test is wrong: the miss line hits the player');
must(R.afterMiss.alive, 'a stroke eight metres wide killed the other player');
must(R.afterMiss.holes >= 1, 'the hole never reached the other page');
must(R.duringRecharge.holes === R.afterMiss.holes && R.duringRecharge.paint === 0,
     'the gun painted again while recharging: ' + JSON.stringify(R.duringRecharge));
must(R.ringCharging, 'the circle did not show that it is recharging');
must(!R.aim.rifleHitsPlayer, 'the kill line is clear, so it does not prove the circle goes through walls');
must(R.whilePainting.paint > 0, 'the paint never reached the other page');
must(R.whilePainting.alive, 'the other player died before the stroke was let go');
must(R.victimDied, 'the player inside the stroke did not die on their own page');
must(R.victim.hp === 0, 'the victim still has health: ' + R.victim.hp);
must(/erased/.test(R.victim.feed), "the victim's killfeed does not say erased");
must(R.shooter.kills === 1, 'the shooter was not credited: ' + R.shooter.kills);

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
must(!errs.length, 'page errors');
console.log(fail.length ? 'FAIL: ' + fail.join('; ')
  : 'PASS: hold paints white and holds you still, release makes a hole you can walk through, it pops at five seconds, out of bounds is instant death, and it kills through walls on release');
await browser.close();
process.exit(fail.length ? 1 : 0);
