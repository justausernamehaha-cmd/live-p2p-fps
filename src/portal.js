// Portal geometry: where a portal may go and what going through one does.
// No three.js, so test/portal.mjs runs in node; the visuals are in portalgun.js.
//
// A portal is an oval on one face of the level:
//   { c  centre on the face,  n  outward normal (the way you come out),
//     u  half-width axis,     v  half-height axis,
//     side 'a'|'b', owner, color, mover (platform index or -1) }

// 1.36 m wide (room for two bodies abreast), 2 m tall
export const HALF_W = 0.68;
export const HALF_H = 1.0;

const MIN_PAIR_SEP = HALF_W * 1.2;
const EPS = 1e-9;
// half a millimetre of slack so a surface exactly a portal's size takes one
const FIT_EPS = 5e-4;

const v3 = (x, y, z) => ({ x, y, z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const sub3 = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const add3 = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const scale3 = (a, k) => v3(a.x * k, a.y * k, a.z * k);
function norm3(a) {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return v3(a.x / l, a.y / l, a.z / l);
}

/** The polygon a world.pick() hit landed on: outward normal plus corners. */
export function faceOf(hit) {
  if (!hit) return null;
  if (hit.solid) {
    const s = hit.solid;
    const f = s.faces[hit.face];
    if (!f) return null;
    return {
      n: v3(f.n[0], f.n[1], f.n[2]),
      verts: f.idx.map(i => v3(s.verts[i][0], s.verts[i][1], s.verts[i][2]))
    };
  }
  const b = hit.box;
  if (!b || !b.min) return null;
  const axis = hit.axis, sign = hit.sign;
  const n = v3(0, 0, 0);
  const k = ['x', 'y', 'z'][axis];
  n[k] = sign;
  const plane = sign > 0 ? b.max[k] : b.min[k];
  // the other two axes in a fixed order, so the corners form a ring
  const [p, q] = axis === 0 ? ['y', 'z'] : axis === 1 ? ['z', 'x'] : ['x', 'y'];
  const corner = (pv, qv) => {
    const o = v3(0, 0, 0);
    o[k] = plane; o[p] = pv; o[q] = qv;
    return o;
  };
  return {
    n,
    verts: [
      corner(b.min[p], b.min[q]), corner(b.max[p], b.min[q]),
      corner(b.max[p], b.max[q]), corner(b.min[p], b.max[q])
    ]
  };
}

/** The oval's axes on a face. The long axis is the shooter's own up flattened
 *  into the face; on a floor or ceiling it follows the look direction, snapped to
 *  a world axis so a square crate top always fits one. */
export function frameFor(n, look, playerUp = null) {
  const up = playerUp && Math.abs(dot(playerUp, n)) < 0.9
    ? norm3(sub3(playerUp, scale3(n, dot(playerUp, n))))
    : v3(0, 1, 0);
  let u;
  if (Math.abs(dot(up, n)) > 0.9) {
    const f = look ? sub3(look, scale3(n, dot(look, n))) : v3(0, 0, -1);
    const along = Math.abs(f.x) > Math.abs(f.z)
      ? v3(Math.sign(f.x) || 1, 0, 0)
      : v3(0, 0, Math.sign(f.z) || -1);
    u = norm3(cross(along, n));
    return { u, v: norm3(cross(n, u)), n };
  }
  u = norm3(cross(up, n));
  return { u, v: norm3(cross(n, u)), n };
}

const TURN_STEP = 5 * Math.PI / 180;    // how finely the other angles are tried

/** Where a shot landing at `point` puts a portal: {c, u, v, n}, or null when the
 *  face cannot hold the whole oval at any angle (the shot explodes).
 *
 *  Legal centres = the face polygon eroded by the oval (every original edge
 *  offset inward by how far the oval reaches toward it, then clipped). The
 *  nearest legal centre to the shot is where it goes, so a portal near an edge
 *  slides inward. */
export function fitPortal(face, point, look, playerUp = null) {
  if (!face || face.verts.length < 3) return null;
  const f = frameFor(face.n, look, playerUp);
  // Upright as aimed if it fits; otherwise turned a quarter, lying on its side.
  const plain = fitFramed(face, point, f.u, f.v, f.n) ||
                fitFramed(face, point, f.v, scale3(f.u, -1), f.n);
  if (plain) return plain;

  // Neither: turn it to whatever angle the surface does take, the least turn
  // from upright first. Tried every TURN_STEP, and lined up with each edge of
  // the face both ways, which is the angle a strip or a triangle takes it at.
  const turned = a => {
    const c = Math.cos(a), s = Math.sin(a);
    return fitFramed(face, point,
      add3(scale3(f.u, c), scale3(f.v, s)), add3(scale3(f.v, c), scale3(f.u, -s)), f.n);
  };
  const angles = [];
  for (let a = TURN_STEP; a < Math.PI / 2 - 1e-6; a += TURN_STEP) angles.push(a);
  for (let i = 0; i < face.verts.length; i++) {
    const e = sub3(face.verts[(i + 1) % face.verts.length], face.verts[i]);
    const along = Math.atan2(dot(e, f.v), dot(e, f.u));
    for (const raw of [along, along + Math.PI / 2]) {
      const a = Math.abs(raw - Math.PI * Math.round(raw / Math.PI));   // into [0, 90]
      if (a > 1e-4 && a < Math.PI / 2 - 1e-4) angles.push(a);
    }
  }
  angles.sort((p, q) => p - q);
  const off = r => r ? Math.hypot(r.c.x - point.x, r.c.y - point.y, r.c.z - point.z) : Infinity;
  for (const a of angles) {
    const one = turned(a), other = turned(-a);
    if (one || other) return off(one) <= off(other) ? one : other;
  }
  return null;
}

function fitFramed(face, point, u, v, n) {
  const origin = face.verts[0];
  const to2 = p => {
    const d = sub3(p, origin);
    return [dot(d, u), dot(d, v)];
  };
  let poly = face.verts.map(to2);
  if (signedArea(poly) < 0) poly = poly.slice().reverse();

  // half-planes from the ORIGINAL edges, not the polygon being clipped
  const planes = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < EPS) continue;
    const nx = -ey / len, ny = ex / len;          // inward for a CCW ring
    // how far the oval itself reaches toward this edge (its bounding box would
    // be the same on a square face and far too cautious on any other)
    planes.push([nx, ny,
      nx * a[0] + ny * a[1] + Math.hypot(HALF_W * nx, HALF_H * ny) - FIT_EPS]);
  }
  for (const [nx, ny, d] of planes) {
    poly = clipHalfPlane(poly, nx, ny, d);
    if (poly.length < 1) return null;
  }

  const [s0, t0] = to2(point);
  const [s, t] = nearestInPoly(poly, s0, t0);
  const c = add3(origin, add3(scale3(u, s), scale3(v, t)));
  return { c, u, v, n };
}

/** Do two mouths overlap? No mouth may be laid over any other. Coplanar mouths
 *  are compared as ovals; on different planes only the centres must be apart. */
export function overlapsMouth(portal, other) {
  if (!other || other === portal) return false;
  const dx = portal.c.x - other.c.x, dy = portal.c.y - other.c.y, dz = portal.c.z - other.c.z;
  const d = Math.hypot(dx, dy, dz);
  const sameFace = dot(portal.n, other.n) > 0.99 &&
                   Math.abs(dx * portal.n.x + dy * portal.n.y + dz * portal.n.z) < 0.02;
  if (sameFace) {
    if (Math.abs(dot(portal.u, other.u)) < 0.999) {     // turned differently
      return rimInside(portal, other) || rimInside(other, portal);
    }
    const su = (dx * other.u.x + dy * other.u.y + dz * other.u.z) / (2 * HALF_W);
    const sv = (dx * other.v.x + dy * other.v.y + dz * other.v.z) / (2 * HALF_H);
    return su * su + sv * sv < 1;
  }
  return d < MIN_PAIR_SEP && dot(portal.n, other.n) > 0.7;
}

/** Is the centre or any of the rim of oval `a` inside oval `b`? */
function rimInside(a, b) {
  for (let i = -1; i < 32; i++) {
    const t = (i / 32) * Math.PI * 2, k = i < 0 ? 0 : 1;
    const p = add3(a.c, add3(scale3(a.u, Math.cos(t) * HALF_W * k), scale3(a.v, Math.sin(t) * HALF_H * k)));
    const rel = sub3(p, b.c);
    const su = dot(rel, b.u) / HALF_W, sv = dot(rel, b.v) / HALF_H;
    if (su * su + sv * sv < 1) return true;
  }
  return false;
}

/** The rigid motion from `from` to `to`: change of frame plus a half turn about
 *  the exit's up, so u and n flip and v does not. `dir` for directions, `point`
 *  for positions. */
export function portalMap(from, to) {
  const dir = d => {
    const a = dot(d, from.u), b = dot(d, from.v), c = dot(d, from.n);
    return v3(
      -a * to.u.x + b * to.v.x - c * to.n.x,
      -a * to.u.y + b * to.v.y - c * to.n.y,
      -a * to.u.z + b * to.v.z - c * to.n.z
    );
  };
  return {
    dir,
    point: p => add3(to.c, dir(sub3(p, from.c)))
  };
}

// Sample points up a body, as fractions of its height. The feet are needed for a
// floor mouth, the head for a ceiling one.
export const BODY_SAMPLES = [0.02, 0.25, 0.5, 0.75, 0.98];

/** Is any part of a body in this mouth? Two-sided: half a body past the surface
 *  is the ordinary case. */
export function atMouth(p, pos, up, height, reach, edge) {
  for (const frac of BODY_SAMPLES) {
    const h = height * frac;
    const dx = pos.x + up.x * h - p.c.x;
    const dy = pos.y + up.y * h - p.c.y;
    const dz = pos.z + up.z * h - p.c.z;
    const d = dx * p.n.x + dy * p.n.y + dz * p.n.z;
    if (d > reach || d < -(height + reach)) continue;
    const su = (dx * p.u.x + dy * p.u.y + dz * p.u.z) / (HALF_W + edge);
    const sv = (dx * p.v.x + dy * p.v.y + dz * p.v.z) / (HALF_H + edge);
    if (su * su + sv * sv <= 1) return true;
  }
  return false;
}

const HOLE_BANDS = 8;

function axisOf(d) {
  if (Math.abs(d.x) > 0.999) return 'x';
  if (Math.abs(d.y) > 0.999) return 'y';
  if (Math.abs(d.z) > 0.999) return 'z';
  return null;
}

/** What is left of an axis-aligned box with a mouth cut through it.
 *
 *  Collision must see a wall with a hole in it, not no wall: removing the whole
 *  box was four separate ways out of the map. The oval is cut in bands, each as
 *  wide as the oval gets within it, so the hole is never narrower than the mouth
 *  and not passable at the corners of its bounding square. The oval may be
 *  turned to any angle in the face; the bands always run along a world axis. */
export function pierce(box, p, pad = 0) {
  const k = axisOf(p.n);
  if (!k) return [];                   // not an axis-aligned face: take it all out
  let ua = axisOf(p.u), va = axisOf(p.v);
  const square = !!ua && !!va;         // the oval's own axes are world axes
  if (!square) [ua, va] = ['x', 'y', 'z'].filter(a => a !== k);
  const out = [];
  const piece = (uLo, uHi, vLo, vHi) => {
    if (uHi - uLo < 1e-4 || vHi - vLo < 1e-4) return;
    const min = {}, max = {};
    min[k] = box.min[k]; max[k] = box.max[k];
    min[ua] = uLo; max[ua] = uHi;
    min[va] = vLo; max[va] = vHi;
    // `rides`: the platform the wall is, for White Out (not `mover`, which would
    // make the pieces platforms in their own right)
    out.push({ min, max, color: box.color, src: box.src, pierced: true, rides: box.mover });
  };
  const cu = p.c[ua], cv = p.c[va];
  const V = HALF_H + pad, U = HALF_W + pad;

  // A turned oval, as the two world axes of its face see it: S is its shape
  // matrix (U^2 uu' + V^2 vv'), so it reaches sqrt(Svv) along va, and at a height
  // q above its centre it spans  q*Suv/Svv -+ wide*sqrt(1 - q^2/Svv)  along ua.
  const Suu = U * U * p.u[ua] * p.u[ua] + V * V * p.v[ua] * p.v[ua];
  const Svv = U * U * p.u[va] * p.u[va] + V * V * p.v[va] * p.v[va];
  const Suv = U * U * p.u[ua] * p.u[va] + V * V * p.v[ua] * p.v[va];
  const reach = square ? V : Math.sqrt(Svv);
  const lean = Suv / Svv, wide = Math.sqrt(Math.max(0, Suu - Suv * Suv / Svv));
  const far = Math.sqrt(Suu), farAt = Suv / far;     // its widest point each way, and how high
  const span = q => {
    const h = wide * Math.sqrt(Math.max(0, 1 - q * q / Svv));
    return [q * lean - h, q * lean + h];
  };

  const v0 = Math.max(box.min[va], cv - reach), v1 = Math.min(box.max[va], cv + reach);
  piece(box.min[ua], box.max[ua], box.min[va], v0);     // below the oval
  piece(box.min[ua], box.max[ua], v1, box.max[va]);     // above it
  const step = (v1 - v0) / HOLE_BANDS;
  for (let i = 0; i < HOLE_BANDS; i++) {
    const bLo = v0 + step * i, bHi = bLo + step;
    let lo, hi;                        // the widest the oval gets within this band
    if (square) {
      const near = Math.min(Math.abs(bLo - cv), Math.abs(bHi - cv),
                            (bLo - cv) * (bHi - cv) <= 0 ? 0 : Infinity);
      const t = Math.min(1, near / V);
      const w = U * Math.sqrt(Math.max(0, 1 - t * t));
      lo = -w; hi = w;
    } else {
      const a = span(bLo - cv), b = span(bHi - cv);
      lo = Math.min(a[0], b[0]); hi = Math.max(a[1], b[1]);
      if (-farAt >= bLo - cv && -farAt <= bHi - cv) lo = -far;
      if (farAt >= bLo - cv && farAt <= bHi - cv) hi = far;
    }
    piece(box.min[ua], Math.max(box.min[ua], cu + lo), bLo, bHi);
    piece(Math.min(box.max[ua], cu + hi), box.max[ua], bLo, bHi);
  }
  return out;
}

/** The link whose mouth a body is standing in, if any. */
export function mouthAround(links, pos, up, height, reach, edge) {
  for (const link of links) {
    if (throughMouth(link.from, pos, up, height, reach, edge)) return link;
  }
  return null;
}

/** Is a body part way through this mouth: across its surface, or within `reach`
 *  of it? Unlike atMouth() a body wholly behind the wall is not, or standing
 *  behind a thin wall with a mouth on its far side grew a second body. */
function throughMouth(p, pos, up, height, reach, edge) {
  const at = h => {
    const dx = pos.x + up.x * h - p.c.x, dy = pos.y + up.y * h - p.c.y, dz = pos.z + up.z * h - p.c.z;
    return {
      d: dx * p.n.x + dy * p.n.y + dz * p.n.z,
      su: (dx * p.u.x + dy * p.u.y + dz * p.u.z) / (HALF_W + edge),
      sv: (dx * p.v.x + dy * p.v.y + dz * p.v.z) / (HALF_H + edge)
    };
  };
  const feet = at(0), head = at(height);
  if (Math.min(feet.d, head.d) > reach || Math.max(feet.d, head.d) < -reach) return false;
  if (feet.d * head.d < 0) {               // across it: judge where it crosses
    const t = feet.d / (feet.d - head.d);
    const su = feet.su + (head.su - feet.su) * t, sv = feet.sv + (head.sv - feet.sv) * t;
    return su * su + sv * sv <= 1;
  }
  for (const frac of BODY_SAMPLES) {
    const s = at(height * frac);
    if (Math.abs(s.d) <= reach && s.su * s.su + s.sv * s.sv <= 1) return true;
  }
  return false;
}

// ------------------------------------------------------------------ colours
// No authority hands colours out, and nobody's colours are changed for them:
// each player picks their own hue and says so. A pair is (h, h+180), so a pair
// is one point on a half circle and two pairs are as alike as those points are
// close. Whoever joined later is the one who moves when two are too close.
const BLUE = 210;
export const SOLO_HUE = BLUE;
const HUE_SEP = 30;

/** How far apart two pairs are, in degrees of the half circle (0 to 90). */
export function hueGap(a, b) {
  const d = (((a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

/** How close two pairs may be with `n` players: 30 degrees, and less only when
 *  the room is too full for that (the middle of the widest gap is always at
 *  least this far from everyone). */
export function hueRoom(n) { return Math.min(HUE_SEP, 90 / Math.max(1, n)); }

/** A hue for someone joining a room with `taken` in it: the one they `want` if
 *  it is clear of everybody, else the middle of the widest gap. */
export function pickHue(taken, want) {
  const need = hueRoom(taken.length + 1);
  if (taken.every(t => hueGap(t, want) >= need)) return want;
  const s = taken.map(t => ((t % 180) + 180) % 180).sort((a, b) => a - b);
  let widest = -1, at = 0;
  for (let i = 0; i < s.length; i++) {
    const next = i + 1 < s.length ? s[i + 1] : s[0] + 180;
    if (next - s[i] > widest) { widest = next - s[i]; at = s[i] + widest / 2; }
  }
  return at % 180;
}

/** The two colours of a hue. */
export function huePair(h) { return pair(h, 0); }

function pair(h, i) {
  const sat = i % 2 ? 0.72 : 0.92;
  return { a: hsl(h, sat, 0.56), b: hsl((h + 180) % 360, sat, 0.56), hue: h };
}

/** hsl -> 0xrrggbb */
function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const q = v => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
}

/** Blue and orange: the pair used before anyone else is in the room. */
export const SOLO_PAIR = pair(BLUE, 0);

// -------------------------------------------------------------- 2D helpers
function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Nearest point of a convex polygon to (s,t). */
function nearestInPoly(poly, s, t) {
  if (poly.length === 1) return poly[0];
  let inside = true;
  for (let i = 0; i < poly.length && inside; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    if ((s - a[0]) * ey - (t - a[1]) * ex > EPS) inside = false;   // right of a CCW edge
  }
  if (inside) return [s, t];
  let best = poly[0], bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey;
    const k = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((s - a[0]) * ex + (t - a[1]) * ey) / len2));
    const px = a[0] + ex * k, py = a[1] + ey * k;
    const d = (px - s) ** 2 + (py - t) ** 2;
    if (d < bestD) { bestD = d; best = [px, py]; }
  }
  return best;
}

/** Distance along a ray to where it enters this mouth from the front, or -1. */
export function rayPortal(origin, dir, portal, maxDist = Infinity) {
  const denom = dot(dir, portal.n);
  if (denom >= -1e-9) return -1;                 // parallel, or from behind
  const t = dot(sub3(portal.c, origin), portal.n) / denom;
  if (t < 1e-4 || t > maxDist) return -1;
  const hit = add3(origin, scale3(dir, t));
  const rel = sub3(hit, portal.c);
  const s = dot(rel, portal.u) / HALF_W;
  const q = dot(rel, portal.v) / HALF_H;
  return s * s + q * q <= 1 ? t : -1;
}

/** Sutherland-Hodgman against `nx*x + ny*y >= d`. */
function clipHalfPlane(poly, nx, ny, d) {
  if (!poly.length) return poly;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - d;
    const db = nx * b[0] + ny * b[1] - d;
    if (da >= -EPS) out.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      const k = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  return out;
}
