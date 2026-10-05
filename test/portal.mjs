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
  HALF_W, HALF_H, faceOf, fitPortal, frameFor, portalMap, atMouth, mouthAround,
  pickHue, hueGap, hueRoom, huePair, SOLO_HUE, overlapsMouth, pierce
} from '../src/portal.js';
import { anglesIn, UP_Y } from '../src/frame.js';
const lookAngles = d => anglesIn(UP_Y, d);
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
t('...slid in until the whole oval is on the face',
  corner && corner.c.x - HALF_W >= -10 - SLACK && corner.c.y - HALF_H >= -SLACK,
  corner && JSON.stringify([fx(corner.c.x), fx(corner.c.y)]));
t('...and no further in than it had to go',
  corner && near(corner.c.x, -10 + HALF_W, 2e-3) && near(corner.c.y, HALF_H, 2e-3),
  corner && JSON.stringify([fx(corner.c.x), fx(corner.c.y)]));

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

// Too short for an upright oval but wide enough for one on its side: it turns.
// 4 m wide, 1.5 m tall — an upright mouth needs 2 m of height, a lying one 1.36.
const strip = { min: { x: -2, y: 0, z: -0.5 }, max: { x: 2, y: 1.5, z: 0.5 } };
const lying = fitPortal(faceOf({ box: strip, axis: 2, sign: -1 }), { x: 0.3, y: 0.7, z: -0.5 }, { x: 0, y: 0, z: 1 });
t('a strip too short for an upright portal takes one on its side', !!lying);
t('...turned a quarter: its long axis is horizontal', lying && near(Math.abs(lying.v.x), 1) && near(lying.u.y * lying.u.y, 1),
  lying && JSON.stringify([lying.u, lying.v]));
t('...still facing out of the face', lying && near(lying.n.z, -1));
t('...and still right-handed (u x v = n)', lying &&
  near(lying.u.x * lying.v.y - lying.u.y * lying.v.x, lying.n.z));
t('...the whole oval on the face', lying &&
  lying.c.x - HALF_H >= -2 - SLACK && lying.c.x + HALF_H <= 2 + SLACK &&
  lying.c.y - HALF_W >= -SLACK && lying.c.y + HALF_W <= 1.5 + SLACK,
  lying && JSON.stringify([fx(lying.c.x), fx(lying.c.y)]));
// and where upright fits, it stays upright
t('a face that holds it upright is not turned', mid && near(Math.abs(mid.v.y), 1));

// The property the fit exists for, checked over the whole face rather than at
// one hand-picked spot: wherever the shot lands, no part of the oval that comes
// back hangs off the surface. A hundred points is cheap and catches a class of
// mistake one corner case walks straight past.
let offFace = 0, refused = 0, moved = 0;
for (let i = 0; i < 100; i++) {
  const px = -10 + (i * 0.2) % 20, py = (i * 0.37) % 6;
  const f = fitPortal(face, { x: px, y: py, z: -0.5 }, { x: 0, y: 0, z: 1 });
  if (!f) { refused++; continue; }
  if (f.c.x - HALF_W < -10 - SLACK || f.c.x + HALF_W > 10 + SLACK ||
      f.c.y - HALF_H < -SLACK || f.c.y + HALF_H > 6 + SLACK) offFace++;
  if (Math.abs(f.c.x - px) > SLACK || Math.abs(f.c.y - py) > SLACK) moved++;
}
t('no shot on a big wall leaves a portal hanging off it', offFace === 0, offFace + ' overhang');
t('...and none of them was refused', refused === 0, refused + ' refused');
// a shot in the open middle of a wall is not slid at all — only edges move
t('a portal in clear space is not shuffled about', moved > 0 && moved < 100,
  moved + ' of 100 had to slide');

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

// ------------------------------------------------- a body standing in a mouth
// The old segment-crossing test went with the teleport. What decides a crossing
// now is the eye passing the surface (player.js); what this file owns is whether
// a body is *in* a mouth at all, which is two-sided — half a body past the plane
// is the ordinary case, not an impossible one.
{
  const up = { x: 0, y: 1, z: 0 };
  // A is centred at (0, 1, 0) facing +z, so a body standing at z = 0.1 is astride it
  t('a body astride a mouth is in it',
    atMouth(A, { x: 0, y: 0, z: 0.1 }, up, 1.8, 0.2, 0.17));
  t('...and so is one pressed to the surface from behind',
    atMouth(A, { x: 0, y: 0, z: -0.1 }, up, 1.8, 0.2, 0.17));
  t('...but not one standing a stride in front of it',
    !atMouth(A, { x: 0, y: 0, z: 0.9 }, up, 1.8, 0.2, 0.17));
  t('...nor one that went through and kept going',
    !atMouth(A, { x: 0, y: 0, z: -3 }, up, 1.8, 0.2, 0.17));
  t('a body beside the mouth is not in it',
    !atMouth(A, { x: 3, y: 0, z: 0.1 }, up, 1.8, 0.2, 0.17));
  // the rim is an entrance: a shoulder's width outside the drawn oval counts
  t('the rim counts as the mouth',
    atMouth(A, { x: HALF_W + 0.1, y: 0, z: 0.1 }, up, 1.8, 0.2, 0.17));
  t('...but only by a shoulder',
    !atMouth(A, { x: HALF_W + 0.6, y: 0, z: 0.1 }, up, 1.8, 0.2, 0.17));
  t('mouthAround names the link a body is standing in',
    mouthAround([{ from: B, to: A }, { from: A, to: B }],
      { x: 0, y: 0, z: 0.1 }, up, 1.8, 0.2, 0.17)?.from === A);
  t('...and nothing where it is standing in none',
    mouthAround([{ from: B, to: A }, { from: A, to: B }],
      { x: 20, y: 0, z: 20 }, up, 1.8, 0.2, 0.17) === null);
}

// a pair cannot be placed on top of itself
t('a portal refuses to swallow its own partner', overlapsMouth(A, { ...A }));
t('...but two a room apart are fine', !overlapsMouth(A, B));

// ------------------------------------------------------------------ colours
t('alone, the pair is blue and orange',
  Math.abs(SOLO_HUE - 210) < 1e-9 && huePair(SOLO_HUE).a === huePair(210).a,
  '#' + huePair(SOLO_HUE).a.toString(16));
t('a pair is the same pair either way round', hueGap(30, 210) === 0 && hueGap(10, 170) === 20);
t('a newcomer keeps the hue they have when nobody is near it', pickHue([210], 100) === 100);
t('...and gives it up when somebody is', hueGap(pickHue([210], 215), 210) >= 30, fx(pickHue([210], 215)));

// One by one into a room, every newcomer wanting the very pair the first has.
// Nobody already there is ever asked to change (pickHue only answers for the
// newcomer), and no two pairs end up alike: 30 degrees apart, or as far as a
// full room allows.
for (let n = 2; n <= 12; n++) {
  const room = [SOLO_HUE];
  while (room.length < n) room.push(pickHue(room, SOLO_HUE));
  let worst = 180;
  for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) worst = Math.min(worst, hueGap(room[i], room[k]));
  t(`${n} players: no two pairs are alike`, worst >= hueRoom(n) - 1e-9,
    'closest ' + fx(worst) + ' degrees, need ' + fx(hueRoom(n)));
}
t('up to three players it is the full 30 degrees', hueRoom(2) === 30 && hueRoom(3) === 30);
t('...and a crowd is allowed closer', hueRoom(9) === 10);

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

// ------------------------------------- the long axis follows the shooter
// The oval is two metres tall and 1.36 across. Which way "tall" points is the
// shooter's own vertical, not the world's: gravity follows a body through a
// mouth, so somebody standing on a wall has an up of their own and a portal laid
// out along the world's y is on its side as far as they are concerned.
{
  const wall = { x: -1, y: 0, z: 0 };            // a face looking along -x
  const look = { x: -1, y: -0.2, z: 0.1 };
  const upright = frameFor(wall, look, { x: 0, y: 1, z: 0 });
  t('an upright player gets a vertical long axis', Math.abs(upright.v.y) > 0.99, JSON.stringify(upright.v));
  // standing on the floor of the room but turned onto the +z wall: up is +z
  const onZ = frameFor(wall, look, { x: 0, y: 0, z: 1 });
  t('...and a player standing on a wall gets theirs', Math.abs(onZ.v.z) > 0.99, JSON.stringify(onZ.v));
  t('...with the short axis across it', Math.abs(onZ.u.y) > 0.99, JSON.stringify(onZ.u));
  // u, v, n stay a right-handed orthonormal frame whatever the up
  for (const f of [upright, onZ]) {
    const d = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    t('the mouth frame stays orthonormal',
      Math.abs(d(f.u, f.v)) < 1e-9 && Math.abs(d(f.u, f.n)) < 1e-9 && Math.abs(d(f.v, f.n)) < 1e-9,
      [d(f.u, f.v), d(f.u, f.n), d(f.v, f.n)].join(' '));
  }
  // an up along the face normal has no projection into the face: fall back to
  // the look direction, snapped, exactly as a floor mouth always has
  const degenerate = frameFor(wall, look, { x: -1, y: 0, z: 0 });
  t('an up along the normal falls back rather than collapsing',
    Math.abs(degenerate.u.x) < 1e-9 && Math.abs(degenerate.v.x) < 1e-9,
    JSON.stringify(degenerate));
}

// ------------------------------------------- turned to whatever angle fits
// "the portal should try its best to self orientate to fit the surface". Every
// claim is checked against this file's own arithmetic: the rim of the oval that
// comes back, walked point by point, against the polygon it was given.
{
  const d = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const rim = (f, k = 1) => Array.from({ length: 72 }, (_, i) => {
    const a = i / 72 * Math.PI * 2, cu = Math.cos(a) * HALF_W * k, sv = Math.sin(a) * HALF_H * k;
    return { x: f.c.x + f.u.x * cu + f.v.x * sv, y: f.c.y + f.u.y * cu + f.v.y * sv, z: f.c.z + f.u.z * cu + f.v.z * sv };
  });
  // inside a convex polygon lying in the plane with normal n (either winding)
  const inFace = (face, p, slack = 2e-3) => {
    let pos = 0, neg = 0;
    for (let i = 0; i < face.verts.length; i++) {
      const a = face.verts[i], b = face.verts[(i + 1) % face.verts.length];
      const e = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, r = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
      const s = d({ x: e.y * r.z - e.z * r.y, y: e.z * r.x - e.x * r.z, z: e.x * r.y - e.y * r.x }, face.n) / Math.hypot(e.x, e.y, e.z);
      if (s > slack) pos++; else if (s < -slack) neg++;
    }
    return !(pos && neg);
  };
  const sound = f => Math.abs(d(f.u, f.v)) < 1e-9 && Math.abs(d(f.u, f.n)) < 1e-9 &&
    Math.abs(Math.hypot(f.u.x, f.u.y, f.u.z) - 1) < 1e-9 && Math.abs(Math.hypot(f.v.x, f.v.y, f.v.z) - 1) < 1e-9 &&
    Math.abs(d({ x: f.u.y * f.v.z - f.u.z * f.v.y, y: f.u.z * f.v.x - f.u.x * f.v.z, z: f.u.x * f.v.y - f.u.y * f.v.x }, f.n) - 1) < 1e-9;
  const look = { x: 0, y: 0, z: 1 };

  // 1.8 x 1.8: too short upright (needs 2), too narrow lying down (needs 2),
  // but the oval fits on the diagonal
  const sq = { min: { x: -0.9, y: 0, z: -0.5 }, max: { x: 0.9, y: 1.8, z: 0.5 } };
  const sqFace = faceOf({ box: sq, axis: 2, sign: -1 });
  const diag = fitPortal(sqFace, { x: 0.1, y: 0.8, z: -0.5 }, look);
  t('a square face too small both ways takes a portal turned to fit', !!diag);
  t('...turned, not upright and not on its side', diag && Math.abs(diag.v.y) < 0.95 && Math.abs(diag.v.x) < 0.95,
    diag && JSON.stringify(diag.v));
  t('...the whole oval on the face', diag && rim(diag).every(p => inFace(sqFace, p)));
  t('...and still a right-handed unit frame', diag && sound(diag));
  // 1.6 x 1.6 holds it at no angle at all (it needs 1.71 on the diagonal)
  const small = { min: { x: -0.8, y: 0, z: -0.5 }, max: { x: 0.8, y: 1.6, z: 0.5 } };
  t('a face that holds it at no angle still explodes',
    fitPortal(faceOf({ box: small, axis: 2, sign: -1 }), { x: 0, y: 0.8, z: -0.5 }, look) === null);

  // a strip 1.5 wide and 6 long lying on the floor at 30 degrees to the grid: a
  // floor mouth is laid out along a world axis, which this strip is nowhere near
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  const corner = (a, b) => ({ x: a * c30 - b * s30, y: 0, z: a * s30 + b * c30 });
  const strip = { n: { x: 0, y: 1, z: 0 }, verts: [corner(-3, -0.75), corner(-3, 0.75), corner(3, 0.75), corner(3, -0.75)] };
  const onStrip = fitPortal(strip, { x: 0.2, y: 0, z: 0.1 }, { x: 0.3, y: -1, z: 0.2 });
  t('a strip at an angle to the grid takes a portal turned along it', !!onStrip);
  t('...the whole oval on the strip', onStrip && rim(onStrip).every(p => inFace(strip, p)));
  t('...a sound frame', onStrip && sound(onStrip));
  // a triangle: only along its long edge
  const tri = { n: { x: 0, y: 0, z: -1 }, verts: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 2.4, z: 0 }, { x: 4.2, y: 0, z: 0 }] };
  const onTri = fitPortal(tri, { x: 1, y: 0.6, z: 0 }, look);
  t('a triangle takes one', !!onTri);
  t('...the whole oval on it', onTri && rim(onTri).every(p => inFace(tri, p)));
  // where it fits upright nothing changes: the wall at the top of this file
  t('a face that holds it upright is still not turned', mid && near(Math.abs(mid.v.y), 1) && near(mid.u.y, 0));

  // the hole collision cuts for a turned mouth: nothing left inside the oval,
  // the wall still there well outside it
  if (diag) {
    const pieces = pierce(sq, diag, 0.2);
    const inPiece = p => pieces.some(b => p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y);
    let inside = 0, outside = 0, wallLeft = 0;
    for (let x = -0.89; x < 0.9; x += 0.03) for (let y = 0.01; y < 1.8; y += 0.03) {
      const r = { x: x - diag.c.x, y: y - diag.c.y, z: 0 };
      const q = (d(r, diag.u) / HALF_W) ** 2 + (d(r, diag.v) / HALF_H) ** 2;
      if (q < 1 && inPiece({ x, y })) inside++;                     // wall inside the mouth
      const far = (d(r, diag.u) / (HALF_W + 0.5)) ** 2 + (d(r, diag.v) / (HALF_H + 0.5)) ** 2;
      if (far > 1) { wallLeft++; if (!inPiece({ x, y })) outside++; }   // hole where the wall is
    }
    t('a turned mouth is cut out of its wall, not the wall taken away', pieces.length > 4, `${pieces.length} pieces`);
    t('...no wall is left anywhere inside the oval', inside === 0, `${inside} points`);
    t('...and the wall well outside it is all still there', outside === 0, `${outside} of ${wallLeft} points`);
  }
  // an upright mouth is cut exactly as it always was
  const up = pierce(wall, mid, 0.2);
  t('an upright mouth still leaves the same eighteen pieces', up.length === 18, `${up.length}`);

  // two mouths on one face, turned differently, may not cross
  const A = { c: { x: 0, y: 3, z: -0.5 }, n: mid.n, u: mid.u, v: mid.v };
  const turn = (f, a) => ({ ...f, u: { x: f.u.x * Math.cos(a) + f.v.x * Math.sin(a), y: f.u.y * Math.cos(a) + f.v.y * Math.sin(a), z: 0 },
                            v: { x: f.v.x * Math.cos(a) - f.u.x * Math.sin(a), y: f.v.y * Math.cos(a) - f.u.y * Math.sin(a), z: 0 } });
  const B = turn({ ...A, c: { x: 1.5, y: 3, z: -0.5 } }, Math.PI / 2);     // lying on its side, 1.5 m along
  t('a mouth on its side reaching into an upright one overlaps it', overlapsMouth(B, A) && overlapsMouth(A, B));
  const C = turn({ ...A, c: { x: 1.8, y: 3, z: -0.5 } }, Math.PI / 2);     // tip at 0.8, the other ends at 0.68
  t('...and clear of it by a hand does not', !overlapsMouth(C, A) && !overlapsMouth(A, C));
}

console.log(ok.length + ' ok');
if (bad.length) { console.log('FAILED:'); bad.forEach(b => console.log('  ' + b)); process.exit(1); }
console.log('portal.js OK');
