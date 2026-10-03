// White Out's geometry, in node — no browser, no server, about a second.
//
// Every claim is checked against an independent answer: the cone's own point
// test, sampled densely, rather than the fast paths compared with themselves.
//
//   node test/erase.mjs
import { Erasures, ERASE_ANGLE, HOLE_TIME, ERASE_RANGE, STAMP_STEP, STROKE_MAX } from '../src/erase.js';

const ok = [], bad = [];
const t = (name, cond, extra = '') => (cond ? ok : bad).push(name + (extra ? ' ' + extra : ''));

// deterministic randomness, so a failure can be reproduced
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const norm = v => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const unit = () => norm({ x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 2 - 1 });
const at = (o, d, s) => ({ x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s });
const toward = (o, p) => norm({ x: p.x - o.x, y: p.y - o.y, z: p.z - o.z });

// ------------------------------------------------------------- the point test
{
  const E = new Erasures();
  const c = E.add({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 0);
  const R20 = 20 * Math.tan(ERASE_ANGLE);
  t('on the axis is gone', E.contains({ x: 0, y: 0, z: -20 }));
  t('just inside the rim is gone', E.contains({ x: R20 * 0.98, y: 0, z: -20 }));
  t('just outside the rim is not', !E.contains({ x: R20 * 1.02, y: 0, z: -20 }));
  t('behind the apex is not', !E.contains({ x: 0, y: 0, z: 5 }));
  t('past the far plane is not', !E.contains({ x: 0, y: 0, z: -(ERASE_RANGE + 1) }));
  t('the circle is small', R20 > 0.9 && R20 < 1.2, `radius at 20 m = ${R20.toFixed(3)}`);
  t('add makes a hole straight away', c && c.hole === true && E.active);
}

// ------------------------------------------------------- paint, then release
{
  const E = new Erasures();
  const o = { x: 0, y: 0, z: 0 };
  E.paint(o, { x: 0, y: 0, z: -1 }, 'me', 1);
  t('paint is not a hole', !E.contains({ x: 0, y: 0, z: -20 }) && !E.active);
  t('paint does not let a ray through', E.rayMask(o, { x: 0, y: 0, z: -1 }, 200).ivs.length === 0);
  t('paint is not erased to collision',
    !E.clearsBox({ x: -0.1, y: -0.1, z: -20.1 }, { x: 0.1, y: 0.1, z: -19.9 }));
  t('the shader is told it is paint', E.uniforms.uEraseN.value === 1 && E.uniforms.uEraseO.value[3] === 0);
  E.paint(o, { x: 1, y: 0, z: 0 }, 'me', 1);
  E.paint(o, { x: 0, y: 1, z: 0 }, 'other', 7);
  const opened = E.open('me', 1, 50);
  t('letting go opens the whole stroke', opened.length === 2 && E.holes === 2 &&
    E.contains({ x: 0, y: 0, z: -20 }) && E.contains({ x: 20, y: 0, z: 0 }));
  t('...and tells the shader', E.uniforms.uEraseO.value[3] === 1 && E.uniforms.uEraseO.value[7] === 1);
  t("somebody else's paint stays paint", !E.contains({ x: 0, y: 20, z: 0 }));
  E.forget('other');
  t('a player who leaves takes their paint with them', E.list.length === 2);
  E.forget('me');
  t('...but never an open hole', E.list.length === 2);
}

// ------------------------------------------------------- a smooth line
// Two stamps a whole ring-width of turn apart. As circles, the point halfway
// between them at 0.98 of the radius off the line is outside both — the scallop
// in the edge. As a sweep it is inside, and the edge is straight.
{
  const E = new Erasures();
  const o = { x: 0, y: 0, z: 0 };
  const d1 = norm({ x: -Math.tan(STAMP_STEP / 2), y: 0, z: -1 }), d2 = norm({ x: Math.tan(STAMP_STEP / 2), y: 0, z: -1 });
  E.paint(o, d1, 'me', 1);
  E.paint(o, d2, 'me', 1);
  E.open('me', 1, 0);
  const R20 = 20 * Math.tan(ERASE_ANGLE);
  const scallop = { x: 0, y: R20 * 0.98, z: -20 };
  const circles = new Erasures();
  circles.add(o, d1, 0); circles.add(o, d2, 0);
  t('as bare circles, the middle of the edge has a notch', !circles.contains(scallop));
  t('swept, the edge is straight there', E.contains(scallop));
  t('...and the sweep is still no wider than the ring', !E.contains({ x: 0, y: R20 * 1.02, z: -20 }));
  // the ray masks approximate the sweep with plain cones: they must agree with the
  // exact test everywhere except within a hair of the edge
  let n = 0, off = 0;
  for (let i = 0; i < 400; i++) {
    const oy = (rnd() * 2 - 1) * R20 * 1.3;
    const ro = { x: -3, y: oy, z: -20 }, rd = { x: 1, y: 0, z: 0 };
    const mask = E.rayMask(ro, rd, 6);
    for (let s = 0.005; s < 6; s += 0.01) {
      n++;
      const truth = E.contains(at(ro, rd, s));
      if (truth !== mask.ivs.some(([a, b]) => s >= a && s <= b)) off++;
    }
  }
  t('ray masks follow the sweep (under 1% of samples differ, all at the edge)', off / n < 0.01,
    `${off} of ${n}`);
}

// ----------------------------------------------------- no portal on White Out
{
  const E = new Erasures();
  const o = { x: 0, y: 0, z: 0 }, u = { x: 1, y: 0, z: 0 }, v = { x: 0, y: 1, z: 0 };
  const R20 = 20 * Math.tan(ERASE_ANGLE);            // the paint's radius on a wall 20 m off
  t('nothing to refuse with no White Out about', !E.coversOval({ x: 0, y: 0, z: -20 }, u, v, 0.68, 1));
  E.paint(o, { x: 0, y: 0, z: -1 }, 'me', 1);
  t('a portal centred on white paint is refused', E.coversOval({ x: 0, y: 0, z: -20 }, u, v, 0.68, 1));
  t('...and one whose rim reaches it', E.coversOval({ x: R20 + 0.6, y: 0, z: -20 }, u, v, 0.68, 1));
  t('...but not one clear of it', !E.coversOval({ x: R20 + 0.75, y: 0, z: -20 }, u, v, 0.68, 1));
  E.open('me', 1, 0);
  t('...nor one hanging over a hole', E.coversOval({ x: R20 + 0.6, y: 0, z: -20 }, u, v, 0.68, 1));
}

// ------------------------------------------------------------------- the pop
{
  const E = new Erasures();
  const c = E.add({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 100);
  const tan = c.tan;
  E.update(100 + HOLE_TIME - 0.01);
  t('full size right up to the end', E.list.length === 1 && c.tan === tan);
  E.update(100 + HOLE_TIME);
  t('gone at once when the time is up', E.list.length === 0 && E.uniforms.uEraseN.value === 0 && !E.active);
  t('the time is five seconds', HOLE_TIME === 5);
}

// ------------------------------------------------------------------- limits
{
  const E = new Erasures();
  let made = 0;
  for (let i = 0; i < STROKE_MAX + 10; i++) if (E.paint({ x: 0, y: 0, z: 0 }, unit(), 'me', 1)) made++;
  t(`a stroke stops at ${STROKE_MAX} stamps`, made === STROKE_MAX);
}

// ------------------------------------------------ ray masks against sampling
{
  let rays = 0, mismatches = 0, worst = '';
  for (let trial = 0; trial < 300; trial++) {
    const E = new Erasures();
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      E.add({ x: rnd() * 40 - 20, y: rnd() * 10, z: rnd() * 40 - 20 }, unit(), 0,
            ERASE_ANGLE * (0.5 + rnd() * 3));
    }
    const c = E.list[0];
    const o = rnd() < 0.3 ? at(c.o, c.d, rnd() * 10 - 5) : { x: rnd() * 60 - 30, y: rnd() * 20 - 5, z: rnd() * 60 - 30 };
    const d = rnd() < 0.3 ? norm({ x: c.d.x + (rnd() - 0.5) * 0.1, y: c.d.y + (rnd() - 0.5) * 0.1, z: c.d.z + (rnd() - 0.5) * 0.1 })
                          : unit();
    const maxT = 120;
    const mask = E.rayMask(o, d, maxT);
    rays++;
    for (let s = 0.005; s < maxT; s += 0.01) {
      const truth = E.contains(at(o, d, s));
      const said = mask.ivs.some(([a, b]) => s >= a && s <= b);
      if (truth === said) continue;
      if (mask.ivs.some(([a, b]) => Math.abs(s - a) < 1e-6 || Math.abs(s - b) < 1e-6)) continue;
      mismatches++;
      if (!worst) worst = `trial ${trial} s=${s.toFixed(3)} truth=${truth} ivs=${JSON.stringify(mask.ivs)}`;
    }
  }
  t(`ray masks agree with the point test (${rays} rays, sampled every cm)`, mismatches === 0, worst);
}

// ----------------------------------------------------------- first solid point
{
  const E = new Erasures();
  E.add({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 0);
  const onAxis = E.rayMask({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 200);
  t('straight down the hole, the wall is not there', onAxis.first(30, 31) === Infinity);
  const off = E.rayMask({ x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 200);
  t('beside the hole, it is', off.first(30, 31) === 30);
  const m = E.rayMask({ x: -5, y: 0, z: -30.5 }, { x: 1, y: 0, z: 0 }, 200);
  const R = 30.5 * Math.tan(ERASE_ANGLE);
  t('across a hole inside a box, solid until the hole', m.first(0, 10) === 0);
  const f2 = m.first(5 - R * 0.5, 10);
  t('starting inside the hole, solid where it ends', Math.abs(f2 - (5 + R)) < 1e-6, `${f2} vs ${5 + R}`);
}

// ------------------------------------------- a body and a hole in a wall
// The cover wall, 1 m thick; a body standing inside it, which is what collision
// asks about while somebody walks through. The shooter stands 4 m back, where one
// stamp is only 0.42 m across: a single circle is far too short for a body, so
// only a dragged stroke — many stamps counted together — can let one through.
{
  const wall = { min: { x: -12, y: 0, z: -34.5 }, max: { x: 12, y: 2.4, z: -33.5 } };
  const body = x => ({ min: { x: x - 0.17, y: 0.05, z: -34.17 }, max: { x: x + 0.17, y: 1.85, z: -33.83 } });
  const eye = { x: 0, y: 1.67, z: -30 };
  // the independent answer: the body's middle line, sampled every centimetre
  const middleClear = (E, x) => {
    for (let y = 0.05; y <= 1.85; y += 0.01) if (!E.contains({ x, y, z: -34 })) return false;
    return true;
  };
  const stroke = (E, keep = () => true) => {
    const from = toward(eye, { x: 0, y: -0.1, z: -34 }), to = toward(eye, { x: 0, y: 2.1, z: -34 });
    const angle = Math.acos(from.x * to.x + from.y * to.y + from.z * to.z);
    const n = Math.ceil(angle / STAMP_STEP);
    for (let i = 0; i <= n; i++) {
      const d = norm({ x: from.x + (to.x - from.x) * i / n, y: from.y + (to.y - from.y) * i / n,
                       z: from.z + (to.z - from.z) * i / n });
      const hitY = eye.y + d.y * (4 / -d.z);
      if (keep(hitY)) E.paint(eye, d, 'me', 1);
    }
    E.open('me', 1, 0);
  };

  const one = new Erasures();
  one.add(eye, toward(eye, { x: 0, y: 0.95, z: -34 }), 0);
  t('one stamp is too short for a standing body', !one.overlapErased(body(0), wall) && !middleClear(one, 0));

  const slot = new Erasures();
  stroke(slot);
  t(`a dragged slot (${slot.holes} stamps) lets a body through`, slot.overlapErased(body(0), wall));
  t('...which agrees with the body line sampled every cm', middleClear(slot, 0));
  t('...though no single stamp of it would',
    slot.list.every(c => { const E = new Erasures(); E.add(c.o, c.d, 0); return !E.overlapErased(body(0), wall); }));
  t('...but not a body standing beside the slot', !slot.overlapErased(body(1.2), wall));

  // two strokes, one below the waist and one above the chest: a single stroke
  // sweeps from stamp to stamp, so only separate strokes can leave a gap
  const gap = new Erasures();
  stroke(gap, y => y < 0.5);
  const gap2 = new Erasures();
  stroke(gap2, y => y > 1.3);
  for (const c of gap2.list) { gap.paint(c.o, c.a, 'me', 2); }
  gap.open('me', 2, 0);
  t('two strokes with a gap between them stop the body', gap.holes > 2 &&
    !gap.overlapErased(body(0), wall) && !middleClear(gap, 0));

  // the floor: feet pressed into it over a hole shot straight down
  const floor = { min: { x: -60, y: -1, z: -60 }, max: { x: 60, y: 0, z: 60 } };
  const feet = x => ({ min: { x: x - 0.17, y: -0.02, z: -40.17 }, max: { x: x + 0.17, y: 1.78, z: -39.83 } });
  const down = new Erasures();
  down.add({ x: 6, y: 30, z: -40 }, { x: 0, y: -1, z: 0 }, 0);
  t('feet over a hole in the floor go through it', down.overlapErased(feet(6), floor));
  t('feet beside it do not', !down.overlapErased(feet(9), floor));
}

// ------------------------------------------------------------ the body test
{
  const E = new Erasures();
  const c = E.add({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 }, 0);
  const up = { x: 0, y: 1, z: 0 };
  const R40 = 40 * Math.tan(ERASE_ANGLE);
  t('a body on the axis is taken', E.touchesBody(c, { x: 0, y: 0, z: -40 }, up, 1.8, 0.17));
  t('a body whose shoulder just reaches the circle is taken',
    E.touchesBody(c, { x: R40 + 0.15, y: 0, z: -40 }, up, 1.8, 0.17));
  t('a body just clear of the circle is not',
    !E.touchesBody(c, { x: R40 + 0.2, y: 0, z: -40 }, up, 1.8, 0.17));
  t('a body behind the shooter is not', !E.touchesBody(c, { x: 0, y: 0, z: 5 }, up, 1.8, 0.17));
  const c2 = E.add({ x: 0, y: 1.6, z: 0 }, { x: 0, y: -1.6, z: -20 }, 0);
  t('only its feet in the circle is still taken', E.touchesBody(c2, { x: 0, y: 0, z: -20 }, up, 1.8, 0.17));
}

// ------------------------------------------- a released stroke is simplified
// Every stamp costs every pixel a shader pass, so on release stamps lying on one
// arc merge. Checked against this file's own arc distance, not erase.js's.
{
  const dotv = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const crossv = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, dotv(a, b))));
  // angle from w to the arc a..b, by brute force: 400 points along the arc
  const toArc = (w, a, b) => {
    let best = Infinity;
    for (let i = 0; i <= 400; i++) {
      const k = i / 400;
      best = Math.min(best, ang(w, norm({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k })));
    }
    return best;
  };
  const toStroke = (w, stamps) => Math.min(...stamps.map(c => toArc(w, c.a, c.b)));
  const o = { x: 0, y: 0, z: 0 };
  const drag = (E, path, id) => { for (const d of path) E.paint(o, d, 'me', id); };
  const TOL = ERASE_ANGLE * 0.2;

  // a straight drag, 30 stamps, becomes one plain cone and one sweep
  const straight = Array.from({ length: 30 }, (_, i) => norm({ x: Math.sin(i * STAMP_STEP), y: 0, z: -Math.cos(i * STAMP_STEP) }));
  const E1 = new Erasures();
  drag(E1, straight, 1);
  const before1 = E1.list.map(c => ({ a: c.a, b: c.b }));
  const opened1 = E1.open('me', 1, 0);
  // 1.5 rad of arc: a plain cone and two sweeps, since one sweep stops at 1 rad
  t('a straight stroke of 30 stamps becomes 3', opened1.length === 3 && E1.list.length === 3, `got ${opened1.length}`);

  // a curling drag (a circle of radius 15 degrees), 36 stamps
  const curl = Array.from({ length: 36 }, (_, i) => {
    const q = i / 35 * Math.PI * 1.5, r = 0.26;
    return norm({ x: Math.sin(r * Math.cos(q)), y: Math.sin(r * Math.sin(q)), z: -1 });
  });
  const E2 = new Erasures();
  drag(E2, curl, 2);
  const before2 = E2.list.map(c => ({ a: c.a, b: c.b }));
  const opened2 = E2.open('me', 2, 0);
  t('a curling stroke gets fewer stamps', opened2.length < before2.length / 2,
    `${before2.length} -> ${opened2.length}`);

  // shape: nowhere does the line move by more than the tolerance
  for (const [name, before, after, path] of [['straight', before1, opened1, straight], ['curl', before2, opened2, curl]]) {
    let worst = 0, missed = 0, extra = 0;
    for (let i = 0; i < 1500; i++) {
      const base = path[(rnd() * path.length) | 0];
      const w = norm({ x: base.x + (rnd() - 0.5) * 0.25, y: base.y + (rnd() - 0.5) * 0.25, z: base.z + (rnd() - 0.5) * 0.25 });
      const d0 = toStroke(w, before), d1 = toStroke(w, after);
      worst = Math.max(worst, Math.abs(d0 - d1));
      const p = at(o, w, 20);
      const E = name === 'straight' ? E1 : E2;
      if (d0 < ERASE_ANGLE - TOL - 0.003 && !E.contains(p)) missed++;
      if (d0 > ERASE_ANGLE + TOL + 0.003 && E.contains(p)) extra++;
    }
    t(`${name}: the line moved by no more than the tolerance`, worst <= TOL + 0.003, `worst ${worst.toFixed(4)} rad`);
    t(`${name}: everything well inside the old hole is still a hole`, missed === 0, `${missed} missed`);
    t(`${name}: nothing well outside the old hole became one`, extra === 0, `${extra} extra`);
  }

  // two peers simplifying the same stroke end with the same holes
  const E3 = new Erasures();
  drag(E3, curl, 2);
  const again = E3.open('me', 2, 0);
  t('simplifying is deterministic', JSON.stringify(again.map(c => [c.a, c.b])) === JSON.stringify(opened2.map(c => [c.a, c.b])));
}

// ------------------------------------------------- a stroke takes a portal
// The oval is 1.36 x 2 on the wall z = -10, seen from 6 m away, where the circle
// is 0.31 m across.
{
  const o = { x: 0, y: 1, z: -4 }, c = { x: 0, y: 1, z: -10 };
  const u = { x: 1, y: 0, z: 0 }, v = { x: 0, y: 1, z: 0 };
  const stroke = (E, id, ...pts) => { for (const p of pts) E.paint(o, toward(o, p), 'me', id); };
  const E = new Erasures();
  stroke(E, 1, { x: 0.5, y: 1.7, z: -10 });                        // a dot near the top right of the oval
  t('paint has not taken the portal yet', !E.holesOval('me', 1, c, u, v, 0.68, 1));
  E.open('me', 1, 0);
  t('one small hole anywhere in the oval takes it', E.holesOval('me', 1, c, u, v, 0.68, 1));
  t('...but only for the stroke that made it', !E.holesOval('me', 2, c, u, v, 0.68, 1) && !E.holesOval('you', 1, c, u, v, 0.68, 1));
  const F = new Erasures();
  stroke(F, 1, { x: 1.0, y: 1, z: -10 });                          // rim of the circle 0.16 m outside the oval
  F.open('me', 1, 0);
  t('a hole beside the oval leaves it', !F.holesOval('me', 1, c, u, v, 0.68, 1));
  const G = new Erasures();
  stroke(G, 1, { x: 0.78, y: 1, z: -10 });                         // the circle's edge 5 cm into the oval
  G.open('me', 1, 0);
  t('a hole that only clips the rim takes it', G.holesOval('me', 1, c, u, v, 0.68, 1));
}

// --------------------------------------------- a platform's own frame (shift)
// A platform keeps its Erasures measured from its own centre; `shift` is only
// read by the shader and by World, so here the claim is just the arithmetic
// World does: a stamp stored relative to the centre at paint time marks the same
// spot OF THE PLATFORM wherever the platform has gone since.
{
  const E = new Erasures();
  const centre = { x: 10, y: 0.65, z: 55 }, eye = { x: 10, y: 1.6, z: 45 };
  const spot = { x: 10, y: 0.9, z: 53 };                           // on the platform's near face
  const local = p => ({ x: p.x - centre.x, y: p.y - centre.y, z: p.z - centre.z });
  E.paint(local(eye), toward(eye, spot), 'me', 1);
  E.open('me', 1, 0);
  t('the marked spot is erased in the platform frame', E.contains(local(spot)));
  // the platform is now 20 m away; the same spot of it is asked for the same way
  centre.x += 20;
  const moved = { x: spot.x + 20, y: spot.y, z: spot.z };
  t('...and still is once the platform has moved', E.contains(local(moved)));
  t('...while the place it was marked AT is no longer', !E.contains(local(spot)));
}

console.log(ok.map(s => '  ok   ' + s).join('\n'));
if (bad.length) console.log(bad.map(s => '  FAIL ' + s).join('\n'));
console.log(bad.length ? `FAIL: ${bad.length} of ${ok.length + bad.length}` : `PASS: ${ok.length} checks`);
process.exit(bad.length ? 1 : 0);
