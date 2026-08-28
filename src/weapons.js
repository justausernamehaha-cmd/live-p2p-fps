export const HEADSHOT_MULT = 2;

// `spread` is the gun's own pattern and is always present — only the shotgun has
// one, because a shot pattern is what a shotgun is. `hipSpread` is the extra cone
// that firing adds, scaled by how accurate the stance is:
//
//   standing   95%  -> 5% of hipSpread
//   moving     90%  -> 10% of hipSpread
export const ACCURACY = { standing: 0.95, moving: 0.90 };

/** Cone half-angle in radians for the current stance. */
export function spreadFor(weapon, moving) {
  const acc = moving ? ACCURACY.moving : ACCURACY.standing;
  return weapon.spread + weapon.hipSpread * (1 - acc);
}

export const WEAPONS = [
  {
    id: 0, name: 'Rifle', auto: true,
    damage: 27, pellets: 1, interval: 0.085, mag: 30, reserve: 150,
    spread: 0, hipSpread: 0.09, recoil: 0.013, recoilYaw: 0.004,
    reloadTime: 2.0, range: 140, color: 0xffd08a, shakeScale: 1
  },
  {
    id: 1, name: 'Shotgun', auto: false,
    damage: 13, pellets: 9, interval: 0.62, mag: 6, reserve: 42,
    spread: 0.055, hipSpread: 0.07, recoil: 0.055, recoilYaw: 0.012,  // the one gun with a pattern
    reloadTime: 2.6, range: 45, color: 0xffb066, shakeScale: 2.2
  },
  {
    id: 2, name: 'Marksman', auto: false,
    damage: 95, pellets: 1, interval: 0.95, mag: 5, reserve: 30,
    spread: 0, hipSpread: 0.12, recoil: 0.09, recoilYaw: 0.01,
    reloadTime: 3.0, range: 250, color: 0x8fd8ff, shakeScale: 2.8
  }
];

export class Loadout {
  constructor() {
    this.index = 0;
    this.previous = 1;
    this.state = WEAPONS.map(w => ({ mag: w.mag, reserve: w.reserve, reloadEnd: 0 }));
    this.nextShot = 0;
    this.firedThisTrigger = false;
  }

  get weapon() { return WEAPONS[this.index]; }
  get ammo() { return this.state[this.index]; }
  get reloading() { return this.ammo.reloadEnd > 0; }

  switchTo(i, t) {
    if (i === this.index || i < 0 || i >= WEAPONS.length) return false;
    this.previous = this.index;
    this.index = i;
    this.nextShot = Math.max(this.nextShot, t + 0.25);   // small swap delay
    return true;
  }

  cycle(dir, t) { return this.switchTo((this.index + dir + WEAPONS.length) % WEAPONS.length, t); }
  swapLast(t) { return this.switchTo(this.previous, t); }

  startReload(t) {
    const w = this.weapon, a = this.ammo;
    if (a.reloadEnd || a.mag >= w.mag || a.reserve <= 0) return false;
    a.reloadEnd = t + w.reloadTime;
    return true;
  }

  update(t) {
    const w = this.weapon, a = this.ammo;
    if (a.reloadEnd && t >= a.reloadEnd) {
      const need = Math.min(w.mag - a.mag, a.reserve);
      a.mag += need;
      a.reserve -= need;
      a.reloadEnd = 0;
    }
    // auto-reload an empty gun rather than making the player press R
    if (!a.reloadEnd && a.mag === 0 && a.reserve > 0) return this.startReload(t);
    return false;
  }

  /** returns the weapon if the trigger produced a shot, else null */
  tryFire(t, triggerHeld, triggerPressed) {
    const w = this.weapon, a = this.ammo;
    if (!triggerHeld) { this.firedThisTrigger = false; return null; }
    if (!w.auto && this.firedThisTrigger && !triggerPressed) return null;
    if (t < this.nextShot || a.reloadEnd || a.mag <= 0) return null;

    a.mag--;
    this.nextShot = t + w.interval;
    this.firedThisTrigger = true;
    return w;
  }

  /** A kill pays out a magazine's worth of ammunition for the gun in hand, up to
   *  what that gun can carry. Returns how many rounds were actually gained. */
  awardOnKill() {
    const w = this.weapon, a = this.ammo;
    const before = a.reserve;
    a.reserve = Math.min(w.reserve, a.reserve + w.mag);
    return a.reserve - before;
  }

  refill() {
    this.state = WEAPONS.map(w => ({ mag: w.mag, reserve: w.reserve, reloadEnd: 0 }));
    this.nextShot = 0;
  }
}
