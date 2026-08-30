// Portals: the geometry half.
//
// Deliberately free of three.js, so it runs in node the way solid.js does and
// `test/portal.mjs` needs neither a browser nor a server. Everything visual
// lives in portalgun.js; everything that decides *where a portal may go* and
// *what coming out of one does to you* lives here.
//
// A portal is an oval lying flat on one face of one piece of world geometry:
//
//   { c:{x,y,z}      its centre, on that face
//     n:{x,y,z}      the face's outward normal — the way you come *out*
//     u:{x,y,z}      the oval's half-width axis   (|u| = 1, HALF_W long)
//     v:{x,y,z}      the oval's half-height axis  (|v| = 1, HALF_H long)
//     side:'a'|'b'   left click or right click
//     owner, color, mover }
//
// `mover` is the index of the moving platform it was placed on, or -1. A portal
// on a platform rides with it, which is the whole reason platforms and portals
// arrived in the same change.

// Two metres tall, at the user's asking — a little over head height, so you walk
// through one rather than duck into it. Width reads "double players wide" as room
// for two of them abreast: the player is 0.34 m across (RADIUS 0.17 in
// player.js), so 1.36 m, with the space between that a doorway needs. A 0.68 m
// mouth would be a quarter of a metre wider than the player and nothing about it
// would feel easy to step into.
export const HALF_W = 0.68;
export const HALF_H = 1.0;

// How far outside the mouth the exit puts you. Enough to clear the player's own
// radius plus the collision skin, so you never materialise inside the wall you
// just came out of.
export const EXIT_CLEAR = 0.22;

// Two portals of the same pair sitting on top of each other is an infinite loop
// with no way out. Refuse it rather than let the player wedge themselves.
const MIN_PAIR_SEP = HALF_W * 1.2;

const EPS = 1e-9;
// Half a millimetre of slack in the fit. A surface built to exactly the size of
// a portal is a surface a portal should go on, and without this the answer is
// decided by whichever way the last bit of a float fell. It is four orders of
// magnitude below anything a person can aim at, so nothing else notices.
const FIT_EPS = 5e-4;

// ---------------------------------------------------------------- small vectors
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

// ------------------------------------------------------------------- the face
/** The polygon a shot landed on, in world space.
 *
 *  world.pick() answers two different shapes: an axis-aligned box names the face
 *  it entered by axis and sign, and a convex solid names the index of the plane.
 *  Both have to come back as the same thing — an outward normal and the corners
 *  of that one face — because fitting an oval onto a surface is the same problem
 *  either way. */
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
  // the two axes that are not the normal, in a fixed order, so the corners come
  // out as a ring rather than a bow tie
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

/** The oval's own axes on a face. Upright wherever "upright" means anything: a
 *  portal on a wall stands up, and one on the floor or the ceiling is turned to
 *  face the way the shooter was looking, so walking in feels like walking in
 *  rather than like being spun. */
export function frameFor(n, look) {
  const up = v3(0, 1, 0);
  let u;
  if (Math.abs(n.y) > 0.9) {
    // Floor or ceiling. Turned to face roughly the way the shooter was looking,
    // but *snapped to the nearest world axis* rather than following the look
    // exactly. A portal is 1.36 by 2, and the top of a crate is 2 by 2: laid
    // diagonally it no longer fits on its own surface and the shot explodes, so
    // whether you could put a portal on a box came down to which way you
    // happened to be standing. Snapped, a square face always takes one.
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

// ------------------------------------------------------------------- fitting
/** Where a portal shot that landed at `point` on `face` actually puts a portal.
 *
 *  Returns {c, u, v, n} on success, or null when the surface cannot hold the
 *  whole oval — in which case the caller makes it explode.
 *
 *  A portal goes exactly where it was shot. It used to slide itself along until
 *  its border lined up with the block's edge, which is not what anybody aiming
 *  at a spot means by hitting it — you would fire at a corner and watch the
 *  portal appear somewhere you had not pointed.
 *
 *  The erosion is still computed, but only to answer the other half of the
 *  question: *can* this surface hold a portal at all? The set of centres at which
 *  an axis-aligned box of half-size (HALF_W, HALF_H) fits inside a convex polygon
 *  is that polygon eroded by the box — push every edge inward by how far the box
 *  reaches along that edge's normal and clip. Empty means the surface is too
 *  small however you place it, and the shot explodes. Anything else takes the
 *  portal at the point of impact, overhang and all. */
export function fitPortal(face, point, look) {
  if (!face || face.verts.length < 3) return null;
  const { u, v, n } = frameFor(face.n, look);
  const origin = face.verts[0];
  const to2 = p => {
    const d = sub3(p, origin);
    return [dot(d, u), dot(d, v)];
  };
  let poly = face.verts.map(to2);
  if (signedArea(poly) < 0) poly = poly.slice().reverse();

  // Every half-plane has to come from the *original* face. Reading the edges out
  // of `poly` as it is clipped walks a moving target: after the first cut the
  // loop is offsetting edges the erosion itself created, and most of the real
  // ones are never applied at all — which let a portal sit half off a surface
  // that was a centimetre too small for it.
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
    if (poly.length < 1) return null;             // nowhere on this face fits
  }

  // where the shot landed, projected onto the face's own plane so a portal is
  // never a hair in front of or behind the surface it is on
  const [s, t] = to2(point);
  const c = add3(origin, add3(scale3(u, s), scale3(v, t)));
  return { c, u, v, n };
}

/** Would this portal swallow its own partner? Two mouths of one pair sitting on
 *  top of each other is a loop with no way out of it. */
export function overlapsPartner(portal, partner) {
  if (!partner) return false;
  const d = Math.hypot(portal.c.x - partner.c.x, portal.c.y - partner.c.y, portal.c.z - partner.c.z);
  return d < MIN_PAIR_SEP && dot(portal.n, partner.n) > 0.7;
}

// --------------------------------------------------------------- traversal
/** Did the segment p0 -> p1 pass through this portal's mouth, front to back?
 *  Returns the fraction along the segment where it crossed, or -1.
 *
 *  `pad` widens the mouth by that many metres in both directions. The player is
 *  a cylinder, not a line, so brushing the rim with your shoulder is still going
 *  in — passing it the player's radius is what makes the edge of a portal an
 *  entrance rather than a place to get stuck against. */
export function crossing(p0, p1, portal, pad = 0) {
  const d0 = dot(sub3(p0, portal.c), portal.n);
  const d1 = dot(sub3(p1, portal.c), portal.n);
  if (d0 <= 0 || d1 > 0) return -1;         // must start in front and end behind
  const denom = d0 - d1;
  if (Math.abs(denom) < EPS) return -1;
  const k = d0 / denom;
  const hit = v3(p0.x + (p1.x - p0.x) * k, p0.y + (p1.y - p0.y) * k, p0.z + (p1.z - p0.z) * k);
  const rel = sub3(hit, portal.c);
  const s = dot(rel, portal.u) / (HALF_W + pad);
  const t = dot(rel, portal.v) / (HALF_H + pad);
  return s * s + t * t <= 1 ? k : -1;
}

/** The rigid motion that takes a point at `from` and delivers it out of `to`.
 *
 *  A portal is entered against its normal and left along the other one's, which
 *  is a half turn about the exit's up axis on top of the change of frame — so
 *  the width axis and the normal both flip and the height axis does not. Applied
 *  to a position it moves you; applied to a direction it turns your momentum and
 *  your view, which is the same map without the offset. */
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

/** Yaw and pitch that look along `d`, in the game's own convention:
 *  forward = (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch). */
export function lookAngles(d) {
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  const x = d.x / len, y = d.y / len, z = d.z / len;
  return {
    yaw: Math.atan2(-x, -z),
    pitch: Math.asin(Math.max(-1, Math.min(1, y)))
  };
}

// ------------------------------------------------------------------ colours
// Nobody is in charge in this game, so the colours cannot be handed out — they
// have to be *agreed*. Every player announces one random number at join time and
// everyone runs this on the same set, so every screen reaches the same answer
// without a word of negotiation.
//
// The two mouths of one pair sit opposite each other on the hue circle, which is
// what makes a lone player's pair blue and orange exactly as asked. All the
// first hues therefore have to live inside one half of the circle, or one
// player's A would land on another's B. Spread them evenly across that half and
// the worst separation is 180/n degrees, at which point saturation is varied as
// well so eight players are still eight distinguishable pairs.
const BLUE = 210;

export function assignHues(players) {
  const list = [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map();
  if (list.length === 0) return out;
  if (list.length === 1) {
    out.set(list[0].id, pair(BLUE, 0));
    return out;
  }
  // one shared random, derived from everybody's: any refresh by anyone moves it
  let sum = 0;
  for (const p of list) sum += (Number.isFinite(p.r) ? p.r : 0);
  const rot = sum - Math.floor(sum);
  const n = list.length;
  const slot = 180 / n;
  list.forEach((p, i) => {
    const r = Number.isFinite(p.r) ? p.r : 0;
    const jitter = (r - 0.5) * slot * 0.4;      // random-looking, still separated
    const h = (BLUE + slot * (i + rot) + jitter + 360) % 360;
    out.set(p.id, pair(h, i));
  });
  return out;
}

function pair(h, i) {
  const sat = i % 2 ? 0.72 : 0.92;
  return { a: hsl(h, sat, 0.56), b: hsl((h + 180) % 360, sat, 0.56), hue: h };
}

/** hsl -> 0xrrggbb, so a hue can be turned into something three.js accepts. */
export function hsl(h, s, l) {
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

/** The default pair, used before anyone else is in the room. */
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

