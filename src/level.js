import { clamp } from './util.js';

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
const MAGIC = 'PA1';

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
      c: clamp((c && c[i]) ?? SHELL_DEFAULT_C[i], 0, 9) | 0
    }));
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

  /** Add a box from two opposite corners. Returns it, or null if degenerate. */
  add(a, b, colorIndex) {
    if (this.boxes.length >= MAX_BOXES) return null;
    const box = {
      id: 'b' + (this._nextId++),
      x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), z0: Math.min(a.z, b.z),
      x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y), z1: Math.max(a.z, b.z),
      c: clamp(colorIndex | 0, 0, 9)
    };
    // a zero-thickness box is invisible and unselectable, so give it the grid
    for (const [lo, hi] of [['x0', 'x1'], ['y0', 'y1'], ['z0', 'z1']]) {
      if (box[hi] - box[lo] < GRID * 0.5) box[hi] = box[lo] + GRID;
    }
    this.clampToRoom(box);
    this.boxes.push(box);
    return box;
  }

  /** Keep a box inside the shell, so nothing can be built where it cannot be reached. */
  clampToRoom(box) {
    const hw = this.w / 2, hl = this.l / 2;
    box.x0 = clamp(box.x0, -hw, hw); box.x1 = clamp(box.x1, -hw, hw);
    box.z0 = clamp(box.z0, -hl, hl); box.z1 = clamp(box.z1, -hl, hl);
    box.y0 = clamp(box.y0, -SHELL_T, this.h); box.y1 = clamp(box.y1, -SHELL_T, this.h);
    return box;
  }

  remove(box) {
    if (!box || box.locked) return false;
    const i = this.boxes.indexOf(box);
    if (i < 0) return false;
    this.boxes.splice(i, 1);
    return true;
  }

  all() { return [...this.shell, ...this.boxes]; }

  /** The shape world.js consumes: min/max plus a resolved colour. `src` links
   *  a rendered box back to the level entry that produced it, which is how a
   *  click in the designer turns into a selection. */
  worldBoxes() {
    return this.all().map(b => ({
      min: { x: b.x0, y: b.y0, z: b.z0 },
      max: { x: b.x1, y: b.y1, z: b.z1 },
      color: COLORS[b.c] ?? COLORS[0],
      src: b
    }));
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
    const boxes = this.boxes.map(b =>
      [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1].map(v => enc(v * UNIT)).join(',') +
      ',' + b.c.toString(36)).join(';');
    const body = `${dims}-${shell}-${boxes}`;
    return `${MAGIC}-${body}-${fnv(body).toString(36)}`;
  }

  /** Parse a seed string. Throws an Error whose message is safe to show. */
  static decode(text) {
    const s = String(text || '').replace(/\s+/g, '').replace(/^["']|["']$/g, '');
    if (!s) throw new Error('empty seed');
    const parts = s.split('-');
    if (parts.length !== 5 || parts[0] !== MAGIC) {
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
        if (f.length !== 7) throw new Error('bad box in the seed');
        const n = f.slice(0, 6).map(v => dec(v) / UNIT);
        if (n.some(v => !Number.isFinite(v))) throw new Error('bad box in the seed');
        level.boxes.push(level.clampToRoom({
          id: 'b' + (level._nextId++),
          x0: n[0], y0: n[1], z0: n[2], x1: n[3], y1: n[4], z1: n[5],
          c: clamp(parseInt(f[6], 36) || 0, 0, 9)
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
