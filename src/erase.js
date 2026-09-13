// White Out geometry (no three.js; tested in node by test/erase.mjs).
//
// Hold fire and drag: the ring on screen is swept along the aim as white paint,
// which is still solid. Let go and the whole stroke becomes a hole at once; it
// stays exactly as it is for HOLE_TIME seconds and then pops shut. The level is
// never edited — collision, hitscan and the shader all subtract the holes.
//
// A stroke is a chain of stamps. Each stamp is a swept cone: apex at the
// shooter's eye, the ring's half-angle, swept along the arc from the previous
// stamp's aim to its own (a round-capped "capsule" in angle), so the painted
// line has smooth edges however it was dragged. The first stamp of a stroke is
// a plain cone.

export const ERASE_ANGLE = 0.052;   // half-angle, radians (~3 degrees)
export const HOLE_TIME = 5;         // seconds a hole stays open before it pops shut
export const ERASE_RANGE = 400;     // far plane
export const STAMP_STEP = ERASE_ANGLE;          // turn between stamps while dragging
const ERASE_MAX = 48;               // stamps in the world at once (shader arrays)
export const STROKE_MAX = 40;       // stamps in one stroke
const SAMPLE = 0.3;                 // collision sampling step, metres
const RAY_SUB = ERASE_ANGLE * 0.25; // ray masks approximate a sweep by cones this far apart

export class Erasures {
  constructor() {
    this.list = [];
    this.holes = 0;
    this.t = 0;
    // shared by every patched material
    this.uniforms = {
      uEraseN: { value: 0 },
      uEraseO: { value: new Float32Array(ERASE_MAX * 4) },   // apex; w = 1 hole, 0 paint
      uEraseA: { value: new Float32Array(ERASE_MAX * 4) },   // sweep start; w = tan(half-angle)
      uEraseB: { value: new Float32Array(ERASE_MAX * 4) }    // sweep end
    };
  }

  /** Is there any hole? Paint is solid, so it does not count. */
  get active() { return this.holes > 0; }

  clear() {
    this.list.length = 0;
    this._refresh();
  }

  /** One stamp of white paint, swept from the stroke's previous stamp. Null when
   *  the stroke or the world is full. */
  paint(o, d, owner = '', stroke = 0, angle = ERASE_ANGLE) {
    if (this.list.length >= ERASE_MAX) return null;
    let prev = null, inStroke = 0;
    for (const c of this.list) {
      if (c.owner === owner && c.stroke === stroke && !c.hole) { inStroke++; prev = c; }
    }
    if (inStroke >= STROKE_MAX) return null;
    const a = unit(d);
    const b = prev ? prev.a : a;
    const tan = Math.tan(angle);
    const cone = {
      o: { x: o.x, y: o.y, z: o.z }, a, b, d: a,
      tan, cos2: 1 / (1 + tan * tan), cosH: Math.cos(angle), sinH: Math.sin(angle),
      owner, stroke, hole: false, born: 0
    };
    const n = cross(a, b), nl = Math.hypot(n.x, n.y, n.z);
    cone.n = nl > 1e-9 ? { x: n.x / nl, y: n.y / nl, z: n.z / nl } : null;
    // plain cones along the sweep, for ray masks and the body test
    const arc = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
    const steps = Math.max(1, Math.ceil(arc / RAY_SUB));
    cone.cones = [];
    for (let i = 0; i <= (cone.n ? steps : 0); i++) {
      const k = i / steps;
      cone.cones.push({ o: cone.o, d: unit({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }),
                        tan, cos2: cone.cos2 });
    }
    this.list.push(cone);
    this._refresh();
    return cone;
  }

  /** The stroke is let go: all its paint becomes holes, born at `t`. Returns them. */
  open(owner, stroke, t = this.t) {
    const opened = [];
    for (const c of this.list) {
      if (c.owner !== owner || c.stroke !== stroke || c.hole) continue;
      c.hole = true;
      c.born = t;
      opened.push(c);
    }
    this._dirty = true;
    this.update(Math.max(this.t, t));
    return opened;
  }

  /** Drop somebody's unfinished paint (they left mid-stroke). */
  forget(owner) {
    this.list = this.list.filter(c => c.hole || c.owner !== owner);
    this._refresh();
  }

  /** A single hole straight away, bypassing paint (tests and tools). */
  add(o, d, t = this.t, angle = ERASE_ANGLE) {
    const stroke = 'add' + Math.random();
    const c = this.paint(o, d, '#add', stroke, angle);
    this.open('#add', stroke, t);
    return c;
  }

  /** Pop holes whose time is up. */
  update(t) {
    this.t = t;
    const before = this.list.length;
    this.list = this.list.filter(c => !c.hole || t - c.born < HOLE_TIME);
    if (this.list.length !== before || this._dirty) this._refresh();
  }

  _refresh() {
    const u = this.uniforms, O = u.uEraseO.value, A = u.uEraseA.value, B = u.uEraseB.value;
    this.holes = 0;
    this.list.forEach((c, i) => {
      if (c.hole) this.holes++;
      O[i * 4] = c.o.x; O[i * 4 + 1] = c.o.y; O[i * 4 + 2] = c.o.z; O[i * 4 + 3] = c.hole ? 1 : 0;
      A[i * 4] = c.a.x; A[i * 4 + 1] = c.a.y; A[i * 4 + 2] = c.a.z; A[i * 4 + 3] = c.tan;
      B[i * 4] = c.b.x; B[i * 4 + 1] = c.b.y; B[i * 4 + 2] = c.b.z;
    });
    u.uEraseN.value = this.list.length;
    this._dirty = false;
  }

  /** Is this point inside a hole? */
  contains(p) {
    for (const c of this.list) if (c.hole && inSweep(c, p.x, p.y, p.z)) return true;
    return false;
  }

  /** Is this box erased, as far as a body is concerned?
   *
   *  Holes count together, so a stroke is one hole. Sampled and deliberately
   *  forgiving: along the box's thin axes only its middle is asked, along a long
   *  one every SAMPLE metres. A body fits through any hole its middle line fits
   *  through, which is what makes a painted slot walkable. */
  clearsBox(min, max) {
    if (!this.holes) return false;
    const cx = (min.x + max.x) / 2, cy = (min.y + max.y) / 2, cz = (min.z + max.z) / 2;
    const rb = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2;
    const near = this.list.filter(c => c.hole && sweepNearSphere(c, cx, cy, cz, rb));
    if (!near.length) return false;
    const steps = (lo, hi) => {
      if (hi - lo < 0.4) return [(lo + hi) / 2];
      const n = Math.ceil((hi - lo) / SAMPLE) + 1;
      return Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
    };
    const xs = steps(min.x, max.x), ys = steps(min.y, max.y), zs = steps(min.z, max.z);
    for (const x of xs) for (const y of ys) for (const z of zs) {
      if (!near.some(c => inSweep(c, x, y, z))) return false;
    }
    return true;
  }

  /** Would a portal's oval touch White Out, paint or hole? Sampled at the centre,
   *  a ring at half size and the rim; a portal may not go on any of it. */
  coversOval(c, u, v, halfW, halfH) {
    if (!this.list.length) return false;
    for (const k of [0, 0.5, 1]) {
      const n = k ? 16 : 1;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const su = Math.cos(a) * halfW * k, sv = Math.sin(a) * halfH * k;
        const x = c.x + u.x * su + v.x * sv, y = c.y + u.y * su + v.y * sv, z = c.z + u.z * su + v.z * sv;
        for (const s of this.list) if (inSweep(s, x, y, z)) return true;
      }
    }
    return false;
  }

  /** Is the overlap of two boxes erased? This is how collision sees a hole. */
  overlapErased(a, b) {
    const min = { x: Math.max(a.min.x, b.min.x), y: Math.max(a.min.y, b.min.y), z: Math.max(a.min.z, b.min.z) };
    const max = { x: Math.min(a.max.x, b.max.x), y: Math.min(a.max.y, b.max.y), z: Math.min(a.max.z, b.max.z) };
    return this.clearsBox(min, max);
  }

  /** The merged stretches of a ray that lie inside holes, within [0, maxT]. */
  rayMask(o, d, maxT = Infinity) {
    const ivs = [];
    for (const c of this.list) if (c.hole) for (const k of c.cones) coneRay(k, o, d, maxT, ivs);
    ivs.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const iv of ivs) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    return new RayMask(merged);
  }

  /** Does one stamp touch any part of a body (capsule along `up`)? */
  touchesBody(stamp, pos, up, height, radius) {
    return stamp.cones.some(c => coneTouchesBody(c, pos, up, height, radius));
  }
}

class RayMask {
  constructor(ivs) { this.ivs = ivs; }

  /** The first solid point in [t0, t1], or Infinity. */
  first(t0, t1) {
    let t = Math.max(0, t0);
    for (const [a, b] of this.ivs) {
      if (b <= t) continue;
      if (a > t) break;
      t = b;
    }
    return t <= t1 ? t : Infinity;
  }
}

const unit = v => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** Inside the swept cone: within the half-angle of the arc from a to b. */
function inSweep(c, x, y, z) {
  const vx = x - c.o.x, vy = y - c.o.y, vz = z - c.o.z;
  const len = Math.hypot(vx, vy, vz);
  if (len <= 0) return false;
  const wx = vx / len, wy = vy / len, wz = vz / len;
  const ca = wx * c.a.x + wy * c.a.y + wz * c.a.z;
  const cb = wx * c.b.x + wy * c.b.y + wz * c.b.z;
  if (Math.max(ca, cb) * len > ERASE_RANGE) return false;
  if (ca >= c.cosH || cb >= c.cosH) return true;          // the round ends
  const n = c.n;
  if (!n) return false;
  const sn = wx * n.x + wy * n.y + wz * n.z;
  if (Math.abs(sn) > c.sinH) return false;
  // the point's direction, flattened into the arc's plane, lies between a and b
  const px = wx - n.x * sn, py = wy - n.y * sn, pz = wz - n.z * sn;
  const s1 = (c.a.y * pz - c.a.z * py) * n.x + (c.a.z * px - c.a.x * pz) * n.y + (c.a.x * py - c.a.y * px) * n.z;
  const s2 = (py * c.b.z - pz * c.b.y) * n.x + (pz * c.b.x - px * c.b.z) * n.y + (px * c.b.y - py * c.b.x) * n.z;
  return s1 >= 0 && s2 >= 0;
}

/** Could the sweep reach a sphere at all? A cheap reject before sampling. */
function sweepNearSphere(c, x, y, z, r) {
  const vx = x - c.o.x, vy = y - c.o.y, vz = z - c.o.z;
  const len = Math.hypot(vx, vy, vz);
  if (len - r > ERASE_RANGE) return false;
  // a cone around `a` wide enough to hold the whole sweep
  const arc = Math.acos(Math.max(-1, Math.min(1, c.a.x * c.b.x + c.a.y * c.b.y + c.a.z * c.b.z)));
  const tanW = Math.tan(Math.min(1.5, Math.atan(c.tan) + arc));
  const s = vx * c.a.x + vy * c.a.y + vz * c.a.z;
  if (s < -r) return false;
  const d2 = Math.max(0, len * len - s * s);
  const reach = Math.max(0, s + r) * tanW + r;
  return d2 <= reach * reach;
}

function coneTouchesBody(cone, pos, up, height, radius) {
  const n = Math.max(2, Math.ceil(height / radius) + 1);
  const grow = radius * Math.sqrt(1 + cone.tan * cone.tan);   // radius / cos(half-angle)
  for (let i = 0; i < n; i++) {
    const h = height * i / (n - 1);
    const vx = pos.x + up.x * h - cone.o.x;
    const vy = pos.y + up.y * h - cone.o.y;
    const vz = pos.z + up.z * h - cone.o.z;
    const s = vx * cone.d.x + vy * cone.d.y + vz * cone.d.z;
    if (s <= -radius || s > ERASE_RANGE) continue;
    const r2 = vx * vx + vy * vy + vz * vz - s * s;
    const R = Math.max(0, s) * cone.tan + grow;
    if (r2 <= R * R) return true;
  }
  return false;
}

/** The part of a ray inside one plain cone, as t intervals pushed onto `out`:
 *  the double-cone quadratic, cut to the forward nappe and the far plane. */
function coneRay(c, o, dir, maxT, out) {
  const D = c.d;
  const vx = o.x - c.o.x, vy = o.y - c.o.y, vz = o.z - c.o.z;
  const dv = D.x * vx + D.y * vy + D.z * vz;
  const dr = D.x * dir.x + D.y * dir.y + D.z * dir.z;
  const vv = vx * vx + vy * vy + vz * vz;
  const vr = vx * dir.x + vy * dir.y + vz * dir.z;
  const rr = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
  const k = c.cos2;
  const A = dr * dr - k * rr, B = 2 * (dv * dr - k * vr), C = dv * dv - k * vv;

  let ivs;
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) < 1e-12) ivs = C >= 0 ? [[-Infinity, Infinity]] : [];
    else {
      const r = -C / B;
      ivs = B > 0 ? [[r, Infinity]] : [[-Infinity, r]];
    }
  } else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) ivs = A > 0 ? [[-Infinity, Infinity]] : [];
    else {
      const sq = Math.sqrt(disc);
      let r1 = (-B - sq) / (2 * A), r2 = (-B + sq) / (2 * A);
      if (r1 > r2) { const x = r1; r1 = r2; r2 = x; }
      ivs = A > 0 ? [[-Infinity, r1], [r2, Infinity]] : [[r1, r2]];
    }
  }

  let lo = 0, hi = maxT;
  if (Math.abs(dr) < 1e-12) {
    if (dv <= 0 || dv > ERASE_RANGE) return;
  } else {
    let ta = -dv / dr, tb = (ERASE_RANGE - dv) / dr;
    if (ta > tb) { const x = ta; ta = tb; tb = x; }
    lo = Math.max(lo, ta);
    hi = Math.min(hi, tb);
  }
  for (const [a, b] of ivs) {
    const s = Math.max(a, lo), e = Math.min(b, hi);
    if (s < e) out.push([s, e]);
  }
}

/** Patch a material: white where painted, discarded inside holes with a white
 *  rim round them. All patched materials share one uniforms object and program. */
export function eraseMaterial(mat, erasures) {
  const U = erasures.uniforms;
  mat.onBeforeCompile = shader => {
    shader.uniforms.uEraseN = U.uEraseN;
    shader.uniforms.uEraseO = U.uEraseO;
    shader.uniforms.uEraseA = U.uEraseA;
    shader.uniforms.uEraseB = U.uEraseB;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEraseW;')
      .replace('#include <project_vertex>',
               '#include <project_vertex>\nvEraseW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ERASE_GLSL)
      .replace('void main() {', 'void main() {\n  float eraseK = eraseWhite();')
      .replace('#include <fog_fragment>',
               'gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), eraseK);\n#include <fog_fragment>');
  };
  mat.customProgramCacheKey = () => 'whiteout2';
  mat.needsUpdate = true;
  return mat;
}

const ERASE_GLSL = `
varying vec3 vEraseW;
uniform int uEraseN;
uniform vec4 uEraseO[${ERASE_MAX}];
uniform vec4 uEraseA[${ERASE_MAX}];
uniform vec4 uEraseB[${ERASE_MAX}];
float eraseWhite() {
  float white = 0.0;
  for (int i = 0; i < ${ERASE_MAX}; i++) {
    if (i >= uEraseN) break;
    vec3 v = vEraseW - uEraseO[i].xyz;
    float len = length(v);
    if (len <= 0.0) continue;
    vec3 w = v / len;
    vec3 a = uEraseA[i].xyz, b = uEraseB[i].xyz;
    float ca = dot(w, a), cb = dot(w, b);
    if (max(ca, cb) <= 0.0 || max(ca, cb) * len > ${ERASE_RANGE.toFixed(1)}) continue;
    // angle from the swept arc: to the arc itself, or to its nearer end
    float ang = acos(clamp(max(ca, cb), -1.0, 1.0));
    vec3 n = cross(a, b);
    float nl = length(n);
    if (nl > 1e-6) {
      n /= nl;
      float sn = dot(w, n);
      vec3 p = w - n * sn;
      if (dot(cross(a, p), n) >= 0.0 && dot(cross(p, b), n) >= 0.0) ang = min(ang, asin(clamp(abs(sn), 0.0, 1.0)));
    }
    float H = atan(uEraseA[i].w);
    if (uEraseO[i].w < 0.5) {             // paint: solid white
      if (ang < H) white = 1.0;
      continue;
    }
    if (ang < H) discard;                 // hole
    float R = len * H, r = len * ang;
    float k = 1.0 - (r - R) / (0.04 + 0.1 * R);
    if (k > 0.0) white = max(white, k * 0.95);   // its rim
  }
  return white;
}
`;
