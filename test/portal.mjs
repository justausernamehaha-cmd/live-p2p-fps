// The portal layer, checked without a browser — like test/solid.mjs, this one
// needs no server and no Chromium and runs in about a second.
//
// What it guards is the three claims the feature is made of: a portal only goes
// where the whole of it fits, a portal that nearly fits *slides* rather than
// being refused, and coming out of one keeps every bit of the momentum that went
// in. Plus the colour agreement, which has no authority behind it and therefore
// has to be provably the same answer on every machine.
//
//   node test/portal.mjs
import {
  HALF_W, HALF_H, faceOf, fitPortal, frameFor, crossing, portalMap,
  lookAngles, assignHues, overlapsPartner
} from '../src/portal.js';
import { Level } from '../src/level.js';
import { makeSolid, SHAPE_SLOPE } from '../src/solid.js';

const ok = [], bad = [];
const t = (name, cond, extra = '') => (cond ? ok : bad).push(name + (extra ? '  ' + extra : ''));
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
const fx = v => +v.toFixed(3);

// ------------------------------------------------------------- faces of a box
// a 20 x 6 x 1 wall, standing on the ground, facing -z
const wall = { min: { x: -10, y: 0, z: -0.5 }, max: { x: 10, y: 6, z: 0.5 } };
const wallHit = { box: wall, axis: 2, sign: -1, point: { x: 0, y: 3, z: -0.5 } };
const face = faceOf(wallHit);
t('a box face has four corners', face && face.verts.length === 4, face && face.verts.length);
t('and the normal it was hit on', face && face.n.z === -1, face && JSON.stringify(face.n));

// ------------------------------------------------------------------- upright
const mid = fitPortal(face, { x: 0, y: 3, z: -0.5 }, { x: 0, y: 0, z: 1 });
t('a shot in the middle of a wall places a portal there',
  mid && near(mid.c.x, 0) && near(mid.c.y, 3), mid && JSON.stringify([fx(mid.c.x), fx(mid.c.y)]));
t('a wall portal stands upright', mid && near(Math.abs(mid.v.y), 1), mid && fx(mid.v.y));
t('and its width axis is horizontal', mid && near(mid.u.y, 0), mid && fx(mid.u.y));

// ------------------------------------------------- it goes where it was shot
// Hard into the bottom-left corner of the same wall. The wall is enormous, so a
// portal is allowed here — and it goes exactly where the shot landed, overhang
// and all. It used to slide until its border lined up with the block's edge,
// which is not what aiming at a spot means.
const corner = fitPortal(face, { x: -9.9, y: 0.05, z: -0.5 }, { x: 0, y: 0, z: 1 });
t('a corner shot still places a portal', !!corner);
// FIT slack: fitPortal allows half a millimetre so an exact fit is not decided
// by the last bit of a float. Nothing here is measuring closer than that.
const SLACK = 1e-3;
t('...exactly where it was shot, not shuffled along the block',
  corner && near(corner.c.x, -9.9, SLACK) && near(corner.c.y, 0.05, SLACK),
  corner && JSON.stringify([fx(corner.c.x), fx(corner.c.y)]));
t('...and it is allowed to hang over the edge',
  corner && corner.c.x - HALF_W < -10, corner && fx(corner.c.x - HALF_W));

// ----------------------------------------------------------- it explodes
// a 1 x 1 m plate cannot hold a 1.36 x 1.8 oval however it is slid
const tiny = { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 1, z: 0.5 } };
const tinyFace = faceOf({ box: tiny, axis: 2, sign: -1, point: { x: 0, y: 0.5, z: -0.5 } });
t('a surface too small refuses the portal',
  fitPortal(tinyFace, { x: 0, y: 0.5, z: -0.5 }, { x: 0, y: 0, z: 1 }) === null);

// exactly big enough: the only legal centre is the middle of it
const exact = {
  min: { x: -HALF_W, y: 0, z: -0.5 }, max: { x: HALF_W, y: HALF_H * 2, z: 0.5 }
};
const exactFace = faceOf({ box: exact, axis: 2, sign: -1 });
// shot dead centre, which is the only place it could sit anyway
const snug = fitPortal(exactFace, { x: 0, y: HALF_H, z: -0.5 }, { x: 0, y: 0, z: 1 });
t('a surface exactly big enough takes a portal',
  snug && near(snug.c.x, 0, 2e-3) && near(snug.c.y, HALF_H, 2e-3),
  snug && JSON.stringify([fx(snug.c.x), fx(snug.c.y)]));

// a hair too small in one direction only
const shy = { min: { x: -HALF_W + 0.01, y: 0, z: -0.5 }, max: { x: HALF_W, y: HALF_H * 2, z: 0.5 } };
t('a hair too narrow explodes',
  fitPortal(faceOf({ box: shy, axis: 2, sign: -1 }), { x: 0, y: 1, z: -0.5 }, { x: 0, y: 0, z: 1 }) === null);

// The property that matters now, checked over the face rather than at one
// hand-picked spot: wherever the shot lands on a surface big enough to hold a
// portal, the portal lands there — never anywhere else. A hundred points is
// cheap and catches a class of mistake one corner case walks straight past.
let moved = 0, refused = 0;
for (let i = 0; i < 100; i++) {
  const px = -10 + (i * 0.2) % 20, py = (i * 0.37) % 6;
  const f = fitPortal(face, { x: px, y: py, z: -0.5 }, { x: 0, y: 0, z: 1 });
  if (!f) { refused++; continue; }
  if (Math.abs(f.c.x - px) > SLACK || Math.abs(f.c.y - py) > SLACK) moved++;
}
t('every shot on a big wall puts the portal where it was aimed', moved === 0, moved + ' were shuffled');
t('...and none of them was refused', refused === 0, refused + ' refused');

// ------------------------------------------------------------------ the floor
const floor = { min: { x: -30, y: -1, z: -30 }, max: { x: 30, y: 0, z: 30 } };
const floorFace = faceOf({ box: floor, axis: 1, sign: 1 });
const down = fitPortal(floorFace, { x: 4, y: 0, z: 4 }, { x: 0, y: -1, z: 0 });
t('a floor portal lies on the floor', down && near(down.n.y, 1), down && fx(down.n.y));
t('...and lands where it was shot', down && near(down.c.x, 4) && near(down.c.z, 4));
t('...with both its axes horizontal',
  down && near(down.u.y, 0, 1e-6) && near(down.v.y, 0, 1e-6),
  down && JSON.stringify([fx(down.u.y), fx(down.v.y)]));

// ------------------------------------------------------------------- a ramp
// a portal on a wedge uses the ramp's own plane, which is neither flat nor upright
const slope = makeSolid({ x0: -6, y0: 0, z0: -6, x1: 6, y1: 4, z1: 6, shape: SHAPE_SLOPE });
const rampIdx = slope.faces.findIndex(f => f.n[1] > 0.1 && Math.abs(f.n[0]) > 0.1);
const rampFace = faceOf({ solid: slope, face: rampIdx });
t('a ramp face is found', rampIdx >= 0 && rampFace && rampFace.verts.length >= 3);
const onRamp = fitPortal(rampFace, { x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 });
t('a portal fits on a ramp', !!onRamp);
t('...lying in the ramp plane',
  onRamp && near(onRamp.u.x * onRamp.n.x + onRamp.u.y * onRamp.n.y + onRamp.u.z * onRamp.n.z, 0, 1e-9));

// ---------------------------------------------------------------- traversal
// two portals facing each other down the z axis, 20 m apart
const A = { c: { x: 0, y: 1, z: 0 }, ...axes({ x: 0, y: 0, z: 1 }) };
const B = { c: { x: 0, y: 1, z: 20 }, ...axes({ x: 0, y: 0, z: -1 }) };
function axes(n) {
  const f = frameFor(n, { x: 0, y: 0, z: -1 });
  return { n: f.n, u: f.u, v: f.v };
}

const map = portalMap(A, B);
// walking straight into A means moving along -n_A; you must leave along +n_B
const outDir = map.dir({ x: 0, y: 0, z: -1 });
t('you leave the exit along its own normal',
  near(outDir.x, B.n.x, 1e-9) && near(outDir.y, B.n.y, 1e-9) && near(outDir.z, B.n.z, 1e-9),
  JSON.stringify([fx(outDir.x), fx(outDir.y), fx(outDir.z)]));

// momentum is turned, never scrubbed — the whole promise of the feature
for (const v of [{ x: 0, y: 0, z: -14 }, { x: 3, y: -9, z: -6 }, { x: -1, y: 12, z: -2 }]) {
  const o = map.dir(v);
  t('momentum keeps its magnitude ' + JSON.stringify(v),
    near(Math.hypot(o.x, o.y, o.z), Math.hypot(v.x, v.y, v.z), 1e-9),
    fx(Math.hypot(o.x, o.y, o.z)) + ' vs ' + fx(Math.hypot(v.x, v.y, v.z)));
}

// a point inside A's mouth has to map to a point inside B's mouth, or a portal
// would be a way of getting inside a wall
for (const [ds, dt] of [[0, 0], [0.9, 0], [0, 0.9], [-0.6, -0.6]]) {
  const p = {
    x: A.c.x + A.u.x * ds * HALF_W + A.v.x * dt * HALF_H,
    y: A.c.y + A.u.y * ds * HALF_W + A.v.y * dt * HALF_H,
    z: A.c.z + A.u.z * ds * HALF_W + A.v.z * dt * HALF_H
  };
  const q = map.point(p);
  const rel = { x: q.x - B.c.x, y: q.y - B.c.y, z: q.z - B.c.z };
  const s = (rel.x * B.u.x + rel.y * B.u.y + rel.z * B.u.z) / HALF_W;
  const u = (rel.x * B.v.x + rel.y * B.v.y + rel.z * B.v.z) / HALF_H;
  t(`inside one mouth maps inside the other (${ds},${dt})`, s * s + u * u <= 1 + 1e-9,
    fx(s * s + u * u));
}

// the view is turned by the same map. A faces +z and B faces -z, so a player
// who walked in heading -z leaves heading -z as well: the same way through the
// world, out of a mouth that happens to point the same way.
const ang = lookAngles(map.dir({ x: 0, y: 0, z: -1 }));
t('the view is turned to match the exit', near(ang.yaw, 0, 1e-6), fx(ang.yaw));
// turn B round and the same entry has to come out the other way
const Bflip = { c: B.c, ...axes({ x: 0, y: 0, z: 1 }) };
t('...and follows the exit when it faces the other way',
  near(Math.abs(lookAngles(portalMap(A, Bflip).dir({ x: 0, y: 0, z: -1 })).yaw), Math.PI, 1e-6),
  fx(lookAngles(portalMap(A, Bflip).dir({ x: 0, y: 0, z: -1 })).yaw));
t('lookAngles round-trips a level look', near(lookAngles({ x: 0, y: 0, z: -1 }).yaw, 0, 1e-9));

// ---------------------------------------------------------------- crossing
// A's normal is +z, so its front is the +z side: you go in heading -z. Entering
// from behind is not entering, which is what stops the exit re-swallowing you.
t('walking into the mouth crosses it',
  crossing({ x: 0, y: 1, z: 0.3 }, { x: 0, y: 1, z: -0.3 }, A) > 0);
t('walking into its back does not',
  crossing({ x: 0, y: 1, z: -0.3 }, { x: 0, y: 1, z: 0.3 }, A) < 0);
t('walking past the edge of it does not',
  crossing({ x: 3, y: 1, z: 0.3 }, { x: 3, y: 1, z: -0.3 }, A) < 0);
t('standing still does not',
  crossing({ x: 0, y: 1, z: 0.3 }, { x: 0, y: 1, z: 0.3 }, A) < 0);
t('just inside the rim crosses',
  crossing({ x: HALF_W * 0.9, y: 1, z: 0.2 }, { x: HALF_W * 0.9, y: 1, z: -0.2 }, A) > 0);
t('and just outside it does not',
  crossing({ x: HALF_W * 1.05, y: 1, z: 0.2 }, { x: HALF_W * 1.05, y: 1, z: -0.2 }, A) < 0);
// the rim is an entrance: a shoulder's width outside the drawn oval still counts
t('brushing the rim from outside the oval still goes in',
  crossing({ x: HALF_W * 1.1, y: 1, z: 0.2 }, { x: HALF_W * 1.1, y: 1, z: -0.2 }, A, 0.17) > 0);
t('...but a long way outside still does not',
  crossing({ x: HALF_W + 0.6, y: 1, z: 0.2 }, { x: HALF_W + 0.6, y: 1, z: -0.2 }, A, 0.17) < 0);
t('a tall player clipping the top of a low portal still goes in',
  crossing({ x: 0, y: 1 + HALF_H * 0.95, z: 0.2 }, { x: 0, y: 1 + HALF_H * 0.95, z: -0.2 }, A) > 0);

// a pair cannot be placed on top of itself
t('a portal refuses to swallow its own partner', overlapsPartner(A, { ...A }));
t('...but two a room apart are fine', !overlapsPartner(A, B));

// ------------------------------------------------------------------ colours
const solo = assignHues([{ id: 'me', r: 0.7 }]);
t('alone, the pair is blue and orange',
  solo.get('me').a === 0x37a2f2 || Math.abs(solo.get('me').hue - 210) < 1e-9,
  '#' + solo.get('me').a.toString(16));

// every peer folds the same set together, whatever order it arrives in
const people = [{ id: 'ddd', r: 0.11 }, { id: 'aaa', r: 0.93 }, { id: 'ccc', r: 0.4 },
                { id: 'bbb', r: 0.62 }];
const one = assignHues(people);
const two = assignHues([...people].reverse());
t('everybody reaches the same colours regardless of order',
  [...one].every(([id, p]) => two.get(id).a === p.a && two.get(id).b === p.b));

// no two mouths anywhere in the room may look alike
for (let n = 2; n <= 8; n++) {
  const room = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, r: (i * 0.37) % 1 }));
  const hues = [];
  for (const p of assignHues(room).values()) hues.push(p.hue % 360, (p.hue + 180) % 360);
  let worst = 360;
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      let d = Math.abs(hues[i] - hues[j]) % 360;
      worst = Math.min(worst, Math.min(d, 360 - d));
    }
  }
  t(`${n} players: no two mouths share a hue`, worst > 360 / (2 * n) * 0.5,
    'closest ' + fx(worst) + ' degrees');
}

// the shared random really does move when somebody refreshes
const before = assignHues([{ id: 'a', r: 0.1 }, { id: 'b', r: 0.2 }]).get('a').hue;
const after = assignHues([{ id: 'a', r: 0.1 }, { id: 'b', r: 0.85 }]).get('a').hue;
t('one player refreshing re-rolls the room', Math.abs(before - after) > 1e-6,
  fx(before) + ' -> ' + fx(after));

// ------------------------------------------------------ platforms in a seed
const lvl = new Level(40, 40, 12);
const box = lvl.add({ x: -2, y: 0, z: -2 }, { x: 2, y: 1, z: 2 }, 3);
t('a fresh box does not move', box.mv === null);
t('a run to where it already is is refused', lvl.setMove(box, lvl.centreOf(box)) === null);
t('...and leaves it standing still', box.mv === null);
lvl.setMove(box, { x: 10, y: 4, z: -2 });
t('a real run is accepted', !!box.mv && box.mv.sp > 0, JSON.stringify(box.mv));

const seed = lvl.encode();
const back = Level.decode(seed);
const rt = back.boxes[0].mv;
t('a platform survives the seed',
  rt && near(rt.x, 10, 1e-6) && near(rt.y, 4, 1e-6) && near(rt.z, -2, 1e-6) && near(rt.sp, 3, 1e-6),
  JSON.stringify(rt));

lvl.setMove(box, null);
t('a platform can be stopped again', box.mv === null);
t('...and a stopped one round-trips as stopped', Level.decode(lvl.encode()).boxes[0].mv === null);

// older seeds, which knew nothing about any of this, still load
const pa2 = 'PA2-' + seed.split('-').slice(1, -1).map((part, i) =>
  i === 2 ? part.split(';').map(b => b.split(',').slice(0, 11).join(',')).join(';') : part).join('-');
const body = pa2.slice(4);
const withSum = 'PA2-' + body + '-' + fnv(body).toString(36);
let pa2ok = false;
try { pa2ok = Level.decode(withSum).boxes.length === 1; } catch (e) { pa2ok = e.message; }
t('a PA2 seed from before platforms still loads', pa2ok === true, String(pa2ok));

function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

console.log(ok.length + ' ok');
if (bad.length) { console.log('FAILED:'); bad.forEach(b => console.log('  ' + b)); process.exit(1); }
console.log('portal.js OK');
