export const HEADSHOT_MULT = 2;

// `spread` is the gun's own pattern and is always present — only the shotgun has
// one, because a shot pattern is what a shotgun is. `hipSpread` is the extra cone
// that hipfire adds, scaled by how accurate the stance is:
//
//   aiming (right click)  100%  -> no added cone at all, moving or not
//   standing hipfire       95%  -> 5% of hipSpread
//   moving hipfire         90%  -> 10% of hipSpread
const ACCURACY = { ads: 1, standing: 0.95, moving: 0.90 };
export const ADS_ZOOM = 1.25;
export const ADS_TIME = 0.4;      // seconds to raise or lower the sights

/** Cone half-angle in radians for the current stance.
 *
 *  A gun marked `perfect` is exempt from all of it: the portal gun places a
 *  portal exactly where it is pointed, standing, sprinting or mid-hop, because
 *  a portal that lands a foot off is not a near miss, it is the wrong wall. */
export function spreadFor(weapon, moving, adsT) {
  if (weapon.perfect) return 0;
  const hipAcc = moving ? ACCURACY.moving : ACCURACY.standing;
  const acc = hipAcc + (ACCURACY.ads - hipAcc) * adsT;
  return weapon.spread + weapon.hipSpread * (1 - acc);
}

export const WEAPONS = [
  {
    id: 0, name: 'Rifle', auto: true,
    damage: 27, pellets: 1, interval: 0.085, mag: 30, reserve: 150, killAward: 30,
    spread: 0, hipSpread: 0.09, recoil: 0.013, recoilYaw: 0.004,
    reloadTime: 2.0, range: 140, color: 0xffd08a, shakeScale: 1,
    // What the *body* is holding, seen from outside. The same shape the
    // viewmodel is, at a distance: a receiver, a barrel, a magazine and a
    // stock, sized per weapon so a stubby shotgun and a long marksman rifle
    // read differently across the map. Used for a peer's body and for your
    // own, which is the point — see `makeBody` in remote.js.
    hold: { barrel: 0.42, bore: 0.05, body: 0.5, tint: 0x2f3644, accent: 0xd9743b }
  },
  {
    id: 1, name: 'Shotgun', auto: false,
    damage: 13, pellets: 9, interval: 0.62, mag: 6, reserve: 42, killAward: 6,
    spread: 0.055, hipSpread: 0.07, recoil: 0.055, recoilYaw: 0.012,  // pattern stays even aimed
    reloadTime: 2.6, range: 45, color: 0xffb066, shakeScale: 2.2,
    hold: { barrel: 0.3, bore: 0.085, body: 0.42, tint: 0x3a2a1e, accent: 0xffb066 }
  },
  {
    id: 2, name: 'Marksman', auto: false,
    damage: 95, pellets: 1, interval: 0.95, mag: 5, reserve: 30, killAward: 5,
    spread: 0, hipSpread: 0.12, recoil: 0.09, recoilYaw: 0.01,
    reloadTime: 3.0, range: 250, color: 0x8fd8ff, shakeScale: 2.8,
    hold: { barrel: 0.72, bore: 0.045, body: 0.5, tint: 0x1d2634, accent: 0x8fd8ff, scope: true }
  },
  {
    // The portal gun. Same rifle in the hand, and that is deliberate — only the
    // coloured brick on top says otherwise, blue on the left and orange on the
    // right. It does no damage, never runs out and never misses, and its two
    // triggers are two colours rather than fire and aim.
    id: 3, name: 'Portal Gun', auto: false,
    damage: 0, pellets: 1, interval: 0.32, mag: 0, reserve: 0, killAward: 0,
    spread: 0, hipSpread: 0, recoil: 0.006, recoilYaw: 0.001,
    reloadTime: 0, range: 220, color: 0x7fd4ff, shakeScale: 0.5,
    perfect: true,     // no cone, in any stance
    noAds: true,       // right click is the second trigger, not the sights
    infinite: true,    // no magazine, nothing to reload
    portal: true,
    hold: { barrel: 0.4, bore: 0.075, body: 0.46, tint: 0x2a3d52, accent: 0x7fd4ff, prongs: true }
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
    if (w.infinite) return false;
    if (a.reloadEnd || a.mag >= w.mag || a.reserve <= 0) return false;
    a.reloadEnd = t + w.reloadTime;
    return true;
  }

  update(t) {
    const w = this.weapon, a = this.ammo;
    if (w.infinite) return false;
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
    if (t < this.nextShot) return null;
    if (!w.infinite && (a.reloadEnd || a.mag <= 0)) return null;

    if (!w.infinite) a.mag--;
    this.nextShot = t + w.interval;
    this.firedThisTrigger = true;
    return w;
  }

  /** The portal gun's two triggers are two colours, not fire and aim, so they
   *  cannot share `firedThisTrigger` — holding one down would lock the other
   *  out. They share only the interval, which is all that needs sharing. */
  tryPortalFire(t, pressed) {
    const w = this.weapon;
    if (!pressed || !w.portal || t < this.nextShot) return null;
    this.nextShot = t + w.interval;
    return w;
  }

  /** A kill is worth exactly one magazine for the gun in hand — 30, 6 or 5 —
   *  rather than the full refill it used to be. Returns how many rounds were
   *  actually gained, which is less than that if it hit the reserve ceiling. */
  awardOnKill() {
    const w = this.weapon, a = this.ammo;
    if (w.infinite) return 0;
    const before = a.reserve;
    a.reserve = Math.min(w.reserve, a.reserve + w.killAward);
    return a.reserve - before;
  }

  refill() {
    this.state = WEAPONS.map(w => ({ mag: w.mag, reserve: w.reserve, reloadEnd: 0 }));
    this.nextShot = 0;
  }
}
