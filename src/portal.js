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

/** Where a shot landing at `point` puts a portal: {c, u, v, n}, or null when the
 *  face cannot hold the whole oval (the shot explodes).
 *
 *  Legal centres = the face polygon eroded by the oval's bounding box (offset
 *  every original edge inward, clip). The nearest legal centre to the shot is
 *  where it goes, so a portal near an edge slides inward. */
export function fitPortal(face, point, look, playerUp = null) {
  if (!face || face.verts.length < 3) return null;
  const { u, v, n } = frameFor(face.n, look, playerUp);
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
    planes.push([nx, ny,
      nx * a[0] + ny * a[1] + HALF_W * Math.abs(nx) + HALF_H * Math.abs(ny) - FIT_EPS]);
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
    const su = (dx * other.u.x + dy * other.u.y + dz * other.u.z) / (2 * HALF_W);
    const sv = (dx * other.v.x + dy * other.v.y + dz * other.v.z) / (2 * HALF_H);
    return su * su + sv * sv < 1;
  }
  return d < MIN_PAIR_SEP && dot(portal.n, other.n) > 0.7;
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
 *  and not passable at the corners of its bounding square. */
export function pierce(box, p, pad = 0) {
  const k = axisOf(p.n);
  const ua = axisOf(p.u), va = axisOf(p.v);
  if (!k || !ua || !va) return [];     // not an axis-aligned face: take it all out
  const out = [];
  const piece = (uLo, uHi, vLo, vHi) => {
    if (uHi - uLo < 1e-4 || vHi - vLo < 1e-4) return;
    const min = {}, max = {};
    min[k] = box.min[k]; max[k] = box.max[k];
    min[ua] = uLo; max[ua] = uHi;
    min[va] = vLo; max[va] = vHi;
    out.push({ min, max, color: box.color, src: box.src, pierced: true });
  };
  const cu = p.c[ua], cv = p.c[va];
  const V = HALF_H + pad, U = HALF_W + pad;
  const v0 = Math.max(box.min[va], cv - V), v1 = Math.min(box.max[va], cv + V);
  piece(box.min[ua], box.max[ua], box.min[va], v0);     // below the oval
  piece(box.min[ua], box.max[ua], v1, box.max[va]);     // above it
  const step = (v1 - v0) / HOLE_BANDS;
  for (let i = 0; i < HOLE_BANDS; i++) {
    const bLo = v0 + step * i, bHi = bLo + step;
    const near = Math.min(Math.abs(bLo - cv), Math.abs(bHi - cv),
                          (bLo - cv) * (bHi - cv) <= 0 ? 0 : Infinity);
    const t = Math.min(1, near / V);
    const w = U * Math.sqrt(Math.max(0, 1 - t * t));
    piece(box.min[ua], Math.max(box.min[ua], cu - w), bLo, bHi);
    piece(Math.min(box.max[ua], cu + w), box.max[ua], bLo, bHi);
  }
  return out;
}

/** The link whose mouth a body is standing in, if any. */
export function mouthAround(links, pos, up, height, reach, edge) {
  for (const link of links) {
    if (atMouth(link.from, pos, up, height, reach, edge)) return link;
  }
  return null;
}

// ------------------------------------------------------------------ colours
// No authority hands colours out. Each player announces one random number and
// everyone folds the same sorted set into the same hues. A pair is (h, h+180), so
// every first hue lives in one half of the circle and pairs never collide.
const BLUE = 210;

export function assignHues(players) {
  const list = [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map();
  if (list.length === 0) return out;
  if (list.length === 1) {
    out.set(list[0].id, pair(BLUE, 0));
    return out;
  }
  let sum = 0;
  for (const p of list) sum += (Number.isFinite(p.r) ? p.r : 0);
  const rot = sum - Math.floor(sum);
  const n = list.length;
  const slot = 180 / n;
  list.forEach((p, i) => {
    const r = Number.isFinite(p.r) ? p.r : 0;
    const jitter = (r - 0.5) * slot * 0.4;
    const h = (BLUE + slot * (i + rot) + jitter + 360) % 360;
    out.set(p.id, pair(h, i));
  });
  return out;
}

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
