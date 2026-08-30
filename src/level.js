import { clamp } from './util.js';
import { SHAPE_BOX, SHAPE_SLOPE } from './solid.js';

// A level is data, not code: a room size plus a list of axis-aligned boxes. That
// is the whole format, and it is all the designer ever produces. The built-in
// arena in world.js stays hand-written; anything a player builds arrives here.

// Ten colours, in the order the number row assigns them. `1` is the first and
// `0` is the tenth — `0` is not a reset.
export const COLORS = [
  0xd9743b,  // 1  orange
  0x3aa89c,  // 2  teal
  0x616e8b,  // 3  slate
  0x4c586f,  // 4  deep slate
  0x76849f,  // 5  pale slate
  0xc7443f,  // 6  red
  0x5f9e4a,  // 7  green
  0x3f6fbf,  // 8  blue
  0xc9a227,  // 9  gold
  0xe8ecf3   // 0  white
];

export const COLOR_NAMES = ['orange', 'teal', 'slate', 'deep slate', 'pale slate',
                            'red', 'green', 'blue', 'gold', 'white'];

export const GRID = 0.5;      // the snap step, and the stair rise the player can walk up
export const SHELL_T = 1;     // how thick the floor, walls and ceiling are

export const MIN_W = 10, MAX_W = 240;
export const MIN_H = 4, MAX_H = 60;
export const MAX_BOXES = 800;

const UNIT = 20;              // coordinates are stored in twentieths of a metre
const ROT = 1000;             // rotations in milliradians: 0.06 degrees, plenty
const MAGIC = 'PA3';          // PA1 had no shape or rotation, PA2 no movement
const OLD_MAGIC = ['PA1', 'PA2'];

// A moving platform travels between where it was built and one other point, at
// a constant speed, turning round at each end and going back. The spec gave no
// timing, so there is one speed and it loops for ever.
export const MOVE_SPEED = 3;      // m/s
const MIN_MOVE = 0.25;     // shorter than this and it is not a journey

// The six shell pieces, in the order they are stored. The floor's top face is
// y = 0, so a player standing on it has the same feet height as in the arena.
const SHELL_KINDS = ['floor', 'ceiling', 'wall -x', 'wall +x', 'wall -z', 'wall +z'];
const SHELL_DEFAULT_C = [3, 3, 2, 2, 2, 2];

export class Level {
  constructor(w = 60, l = 60, h = 12) {
    this.w = clampDim(w, MIN_W, MAX_W);
    this.l = clampDim(l, MIN_W, MAX_W);
    this.h = clampDim(h, MIN_H, MAX_H);
    this.boxes = [];                 // {id, x0,y0,z0, x1,y1,z1, c}
    this.shell = [];
    this.fillets = [];               // derived from the shell, never stored
    this._nextId = 1;
    this.buildShell(SHELL_DEFAULT_C.slice());
  }

  /** (Re)make the six shell pieces for the current dimensions, keeping colours. */
  buildShell(colors) {
    const c = colors || this.shell.map(b => b.c);
    const hw = this.w / 2, hl = this.l / 2, T = SHELL_T, h = this.h;
    const defs = [
      [-hw - T, -T, -hl - T, hw + T, 0, hl + T],       // floor
      [-hw - T, h, -hl - T, hw + T, h + T, hl + T],    // ceiling
      [-hw - T, 0, -hl, -hw, h, hl],                   // wall -x
      [hw, 0, -hl, hw + T, h, hl],                     // wall +x
      [-hw - T, 0, -hl - T, hw + T, h, -hl],           // wall -z
      [-hw - T, 0, hl, hw + T, h, hl + T]              // wall +z
    ];
    this.shell = defs.map((d, i) => ({
      id: 'shell' + i,
      kind: SHELL_KINDS[i],
      locked: true,                  // colourable, never deletable
      x0: d[0], y0: d[1], z0: d[2], x1: d[3], y1: d[4], z1: d[5],
      c: clamp((c && c[i]) ?? SHELL_DEFAULT_C[i], 0, 9) | 0,
      shape: SHAPE_BOX, rx: 0, ry: 0, rz: 0
    }));
    this._buildFillets();
  }

  /** A 45-degree wedge in each of the room's eight inside corners: four where
   *  the walls meet the floor and four where they meet the ceiling.
   *
   *  Gravity follows a player through a portal, so somebody can end up standing
   *  on a wall — and a right-angled corner is a dead end for them, with no
   *  surface between the wall and the floor that either of them can walk on. The
   *  fillet belongs to both, which is what lets it hand them back (see
   *  Player._groundUp).
   *
   *  Derived, never encoded: they follow from the room's own size, so a seed
   *  written before they existed still describes exactly this room, and one
   *  written now still reads on a page that has not been updated. Like the shell
   *  they are locked — a wedge you could delete would be a corner you could get
   *  stuck in. Extents are stored in the wedge's own frame, which the turn about
   *  Y then permutes into the world's. */
  _buildFillets() {
    const hw = this.w / 2, hl = this.l / 2, h = this.h, P = Math.PI;
    const F = Math.min(1.6, h / 3, this.w / 4, this.l / 4);
    const runs = [
      { x: -hw, z: 0, axis: 'x', dir: 1, ry: P, width: this.l + 2 * SHELL_T },
      { x: hw, z: 0, axis: 'x', dir: -1, ry: 0, width: this.l + 2 * SHELL_T },
      { x: 0, z: -hl, axis: 'z', dir: 1, ry: P / 2, width: this.w + 2 * SHELL_T },
      { x: 0, z: hl, axis: 'z', dir: -1, ry: -P / 2, width: this.w + 2 * SHELL_T }
    ];
    this.fillets = [];
    let i = 0;
    for (const r of runs) {
      const cx = r.axis === 'x' ? r.x + (F / 2) * r.dir : r.x;
      const cz = r.axis === 'z' ? r.z + (F / 2) * r.dir : r.z;
      for (const [y0, rz] of [[0, 0], [h - F, P]]) {
        this.fillets.push({
          id: 'fillet' + (i++), kind: 'corner', locked: true,
          x0: cx - F / 2, x1: cx + F / 2,
          y0, y1: y0 + F,
          z0: cz - r.width / 2, z1: cz + r.width / 2,
          c: SHELL_DEFAULT_C[2], shape: SHAPE_SLOPE, rx: 0, ry: r.ry, rz
        });
      }
    }
  }

  resize(w, l, h) {
    this.w = clampDim(w, MIN_W, MAX_W);
    this.l = clampDim(l, MIN_W, MAX_W);
    this.h = clampDim(h, MIN_H, MAX_H);
    this.buildShell();
    // anything now outside the room would be unreachable and un-deletable
    this.boxes = this.boxes.filter(b => this.inside(b));
  }

  inside(b) {
    const hw = this.w / 2, hl = this.l / 2;
    return b.x1 > -hw - 0.01 && b.x0 < hw + 0.01 &&
           b.z1 > -hl - 0.01 && b.z0 < hl + 0.01 &&
           b.y1 > -SHELL_T - 0.01 && b.y0 < this.h + SHELL_T + 0.01;
  }

  /** Add a box from two opposite corners. Returns it, or null if degenerate.
   *  `shape` picks a full box or a wedge; `rot` is the Euler triple it is turned
   *  by about its own centre. */
  add(a, b, colorIndex, shape = SHAPE_BOX, rot = null) {
    if (this.boxes.length >= MAX_BOXES) return null;
    const box = {
      id: 'b' + (this._nextId++),
      x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), z0: Math.min(a.z, b.z),
      x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y), z1: Math.max(a.z, b.z),
      c: clamp(colorIndex | 0, 0, 9),
      shape: shape === SHAPE_SLOPE ? SHAPE_SLOPE : SHAPE_BOX,
      rx: rot ? rot[0] : 0, ry: rot ? rot[1] : 0, rz: rot ? rot[2] : 0,
      mv: null              // {x,y,z,sp}: where its centre travels to, and how fast
    };
    // a zero-thickness box is invisible and unselectable, so give it the grid
    for (const [lo, hi] of [['x0', 'x1'], ['y0', 'y1'], ['z0', 'z1']]) {
      if (box[hi] - box[lo] < GRID * 0.5) box[hi] = box[lo] + GRID;
    }
    this.clampToRoom(box);
    this.boxes.push(box);
    return box;
  }

  /** Keep a box inside the shell, so nothing can be built where it cannot be
   *  reached. A turned box is clamped by its centre instead: squeezing its
   *  extents would change the shape rather than move it. */
  clampToRoom(box) {
    const hw = this.w / 2, hl = this.l / 2;
    if (box.rx || box.ry || box.rz) {
      const shift = (lo, hi, limit) => {
        const c = (lo + hi) / 2;
        return clamp(c, -limit, limit) - c;
      };
      const dx = shift(box.x0, box.x1, hw);
      const dz = shift(box.z0, box.z1, hl);
      box.x0 += dx; box.x1 += dx;
      box.z0 += dz; box.z1 += dz;
      return box;
    }
    box.x0 = clamp(box.x0, -hw, hw); box.x1 = clamp(box.x1, -hw, hw);
    box.z0 = clamp(box.z0, -hl, hl); box.z1 = clamp(box.z1, -hl, hl);
    box.y0 = clamp(box.y0, -SHELL_T, this.h); box.y1 = clamp(box.y1, -SHELL_T, this.h);
    return box;
  }

  /** Make a box travel to `end` and back, or stop it travelling.
   *
   *  The box keeps the position it was built at — that is the start of the run,
   *  and what the seed stores — and `mv` is the far end of it. What travels is
   *  the box's own middle, so aiming at a point puts the *centre* there rather
   *  than a corner, which is what a person pointing at a spot means.
   *
   *  Returns the box on success, or null when the two points are the same place
   *  and there would be nothing to watch. */
  setMove(box, end, speed = MOVE_SPEED) {
    if (!box || box.locked) return null;
    if (!end) { box.mv = null; return box; }
    const c = this.centreOf(box);
    const dist = Math.hypot(end.x - c.x, end.y - c.y, end.z - c.z);
    if (dist < MIN_MOVE) { box.mv = null; return null; }
    box.mv = { x: end.x, y: end.y, z: end.z, sp: clamp(speed, 0.2, 20) };
    return box;
  }

  centreOf(b) {
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 };
  }

  remove(box) {
    if (!box || box.locked) return false;
    const i = this.boxes.indexOf(box);
    if (i < 0) return false;
    this.boxes.splice(i, 1);
    return true;
  }

  all() { return [...this.shell, ...this.fillets, ...this.boxes]; }

  /** What world.js consumes: the level's entries with a resolved colour. It
   *  decides which are plain AABBs and which need the convex path. `src` links
   *  anything rendered back to the level entry that produced it, which is how a
   *  click in the designer turns into a selection. */
  worldBoxes() {
    return this.all().map(b => ({ ...b, color: COLORS[b.c] ?? COLORS[0], src: b }));
  }

  /** Eight points on a ring, each dropped onto whatever is under it. */
  spawnPoints(boxes) {
    const r = Math.min(this.w, this.l) * 0.32;
    const out = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      out.push(dropOnto(Math.cos(a) * r, Math.sin(a) * r, boxes, this.h));
    }
    return out;
  }

  // ------------------------------------------------------------- seed string
  /** Everything needed to rebuild this level, as one paste-safe line. */
  encode() {
    const dims = [this.w, this.l, this.h].map(v => enc(v * UNIT)).join(',');
    const shell = this.shell.map(b => b.c.toString(36)).join('');
    // A speed of zero is what says "this one does not move" — the end point
    // cannot, since the origin is a perfectly good place to travel to.
    const boxes = this.boxes.map(b =>
      [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1].map(v => enc(v * UNIT)).join(',') +
      ',' + b.c.toString(36) + ',' + (b.shape || 0).toString(36) + ',' +
      [b.rx || 0, b.ry || 0, b.rz || 0].map(v => enc(v * ROT)).join(',') + ',' +
      [b.mv ? b.mv.x : 0, b.mv ? b.mv.y : 0, b.mv ? b.mv.z : 0, b.mv ? b.mv.sp : 0]
        .map(v => enc(v * UNIT)).join(',')).join(';');
    const body = `${dims}-${shell}-${boxes}`;
    return `${MAGIC}-${body}-${fnv(body).toString(36)}`;
  }

  /** Parse a seed string. Throws an Error whose message is safe to show. */
  static decode(text) {
    const s = String(text || '').replace(/\s+/g, '').replace(/^["']|["']$/g, '');
    if (!s) throw new Error('empty seed');
    const parts = s.split('-');
    // PA1 seeds had neither a shape nor a rotation, and PA2 had no movement.
    // They still load: their boxes are upright, still boxes, and standing still,
    // which is exactly what the missing fields would have said.
    if (parts.length !== 5 || (parts[0] !== MAGIC && !OLD_MAGIC.includes(parts[0]))) {
      throw new Error('that does not look like a level seed');
    }
    const [, dims, shellStr, boxStr, sum] = parts;
    if (fnv(`${dims}-${shellStr}-${boxStr}`).toString(36) !== sum) {
      throw new Error('the seed is damaged — it looks like part of it was lost in the copy');
    }
    const d = dims.split(',').map(v => dec(v) / UNIT);
    if (d.length !== 3 || d.some(v => !Number.isFinite(v))) throw new Error('bad room size');

    const level = new Level(d[0], d[1], d[2]);
    const shellColors = [...shellStr].map(ch => clamp(parseInt(ch, 36) || 0, 0, 9));
    if (shellColors.length !== 6) throw new Error('bad shell colours');
    level.buildShell(shellColors);

    if (boxStr) {
      const entries = boxStr.split(';');
      if (entries.length > MAX_BOXES) throw new Error(`too many boxes (${entries.length})`);
      for (const e of entries) {
        const f = e.split(',');
        if (f.length !== 7 && f.length !== 11 && f.length !== 15) {
          throw new Error('bad box in the seed');
        }
        const n = f.slice(0, 6).map(v => dec(v) / UNIT);
        if (n.some(v => !Number.isFinite(v))) throw new Error('bad box in the seed');
        const r = f.length >= 11 ? f.slice(8, 11).map(v => dec(v) / ROT) : [0, 0, 0];
        if (r.some(v => !Number.isFinite(v))) throw new Error('bad rotation in the seed');
        const m = f.length === 15 ? f.slice(11, 15).map(v => dec(v) / UNIT) : [0, 0, 0, 0];
        if (m.some(v => !Number.isFinite(v))) throw new Error('bad movement in the seed');
        level.boxes.push(level.clampToRoom({
          id: 'b' + (level._nextId++),
          x0: n[0], y0: n[1], z0: n[2], x1: n[3], y1: n[4], z1: n[5],
          c: clamp(parseInt(f[6], 36) || 0, 0, 9),
          shape: f.length >= 11 && parseInt(f[7], 36) === SHAPE_SLOPE ? SHAPE_SLOPE : SHAPE_BOX,
          rx: r[0], ry: r[1], rz: r[2],
          mv: m[3] > 0 ? { x: m[0], y: m[1], z: m[2], sp: clamp(m[3], 0.2, 20) } : null
        }));
      }
    }
    return level;
  }
}

function clampDim(v, lo, hi) {
  const n = Number(v);
  return Math.round(clamp(Number.isFinite(n) ? n : lo, lo, hi) / GRID) * GRID;
}

/** Highest surface under (x,z) that leaves standing room, else the floor. */
function dropOnto(x, z, boxes, roomH) {
  let top = 0;
  for (const b of boxes || []) {
    const mn = b.min || b, mx = b.max || b;
    if (x < mn.x || x > mx.x || z < mn.z || z > mx.z) continue;
    if (mx.y > top && mx.y + 1.9 < roomH) top = mx.y;
  }
  return { x, y: top + 0.05, z };
}

export { SHAPE_BOX, SHAPE_SLOPE };

// Zig-zag so a negative coordinate still encodes as base 36 with no sign
// character, which keeps the whole seed safe in a URL fragment.
const enc = n => zig(Math.round(n)).toString(36);
const dec = s => unzig(parseInt(s, 36));
const zig = n => (n < 0 ? -n * 2 - 1 : n * 2);
const unzig = z => (Number.isFinite(z) ? (z % 2 ? -(z + 1) / 2 : z / 2) : NaN);

function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
