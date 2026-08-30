import { clamp, now } from './util.js';

// One input layer for every device. Keyboard, mouse, and touch all write into
// the same state, and they are additive: a phone with a Bluetooth keyboard
// drives movement from WASD while the thumb on the right half still aims.

// The stock bindings. They are only defaults now: the settings panel writes a
// copy of this map to localStorage, so `binds` is what the game actually reads.
export const DEFAULT_BINDS = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyC: 'crouch', ControlLeft: 'crouch', ControlRight: 'crouch',
  KeyF: 'fire',                       // keyboard-only fallback when there is no mouse
  KeyR: 'reload', KeyQ: 'lastweapon', Tab: 'score',
  Digit1: 'weapon1', Digit2: 'weapon2', Digit3: 'weapon3', Digit4: 'weapon4',
  Backquote: 'settings', Escape: 'menu'
};

// These open something rather than holding something down, so they fire once on
// the press and never enter the held set. Escape additionally opens the menu by
// way of losing the pointer lock, which the browser does on its own — rebinding
// `menu` adds a key, it cannot take Escape away.
const UI_ACTIONS = new Set(['settings', 'menu']);

// Shown in the settings panel, in this order. Anything not listed here is still
// bindable in principle but has no row, which keeps the panel to one screen.
export const BINDABLE = [
  ['fwd', 'Forward'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'],
  ['jump', 'Jump'], ['sprint', 'Sprint'], ['crouch', 'Crouch'],
  ['fire', 'Fire'], ['reload', 'Reload'], ['lastweapon', 'Last weapon'],
  ['weapon1', 'Weapon 1'], ['weapon2', 'Weapon 2'], ['weapon3', 'Weapon 3'],
  ['weapon4', 'Weapon 4 (portal gun)'],
  ['score', 'Scoreboard'], ['settings', 'Open settings'], ['menu', 'Open menu']
];

// Actions that can be held or latched. Sprint and jump are here because on a
// phone a third finger is not available, and a latched jump is what makes bunny
// hopping possible with a thumb.
export const TOGGLEABLE = [
  ['crouch', 'Crouch'], ['ads', 'Aim'], ['sprint', 'Sprint'], ['jump', 'Jump']
];

// The level designer has its own keyboard entirely. Separate map, separate
// storage: the two modes never run at once, so `R` can reload a rifle in a match
// and rotate a ramp while building without either having to give way.
export const DEFAULT_DESIGN_BINDS = {
  ShiftLeft: 'fast', ShiftRight: 'fast',
  Space: 'up', KeyC: 'down',
  AltLeft: 'freemouse', AltRight: 'freemouse',
  KeyQ: 'corner1', KeyE: 'corner2',
  KeyF: 'shape', KeyR: 'rotate', KeyX: 'axis',
  // T is the platform key now, so delete moved onto the key that is called
  // Delete. Nothing about the old binding was worth keeping over that.
  KeyT: 'platform', Delete: 'ddelete',
  KeyG: 'snap', KeyH: 'keylist', Tab: 'playtest'
};

export const DESIGN_BINDABLE = [
  ['fast', 'Fly fast'], ['up', 'Fly up'], ['down', 'Fly down'],
  ['freemouse', 'Free the mouse'],
  ['corner1', 'Floating box: corner A'], ['corner2', 'Floating box: corner B'],
  ['shape', 'Box / ramp'], ['rotate', 'Rotate selection'],
  ['axis', 'Next rotation axis'], ['ddelete', 'Delete selection'],
  ['platform', 'Make it a moving platform'],
  ['snap', 'Grid snap'], ['keylist', 'Hide the key list'], ['playtest', 'Playtest']
];

const BIND_KEY = 'pa.binds';
const DESIGN_BIND_KEY = 'pa.designbinds';

const LOOK_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const MOUSE_SENS = 0.0022;   // radians per pixel
const TOUCH_SENS = 0.0042;
const KEY_LOOK_RATE = 2.4;   // radians per second for arrow-key aiming
const STICK_RADIUS = 62;
const LOCK_RETRY_MS = 1200;  // Chrome refuses a re-lock briefly after every Esc
const SETTLE_MS = 250;       // a lock can emit more than one bookkeeping move
// A locked pointer gets warped back to the centre of the screen by the browser,
// and the warp is reported as movement equal to the distance from the cursor to
// that centre. Measured, those arrive at 44-1500 px/ms; a human flick is under
// 10. Speed separates them cleanly where magnitude cannot: the warp is small
// when you click near the middle and large when you click at the edge, so any
// fixed pixel threshold either lets it through or eats real aiming.
// A hard ceiling on how far one event may turn the view. This replaces every
// heuristic that tried to work out whether a large movement was "real": those
// all needed to guess the cause, and guessing was wrong three times running.
//
// It cannot be wrong. Mouse movement arrives at 60-125Hz, so 50px per event
// still allows turning at ~380 degrees a second at default sensitivity, and the
// ceiling scales with the sensitivity setting because the clamp is applied to
// pixels before that multiplier. But a single spike of any origin - a
// pointer-lock settle, an OS acceleration curve amplifying the nudge your hand
// gives the mouse as you click, a synthetic warp - can no longer move the view
// more than about six degrees.
const MAX_PX_PER_EVENT = 50;
// Pressing any mouse button physically nudges the mouse - noticeably so when the
// left button is pressed while the right is held, which rotates the hand
// leftwards - and pointer acceleration turns a few millimetres into tens of
// reported pixels.
//
// Two stages. The jolt itself is dropped outright; the rest of the press is
// throttled, so deliberately tracking a target while shooting still works and
// only lurches are removed.
const CLICK_DEAD_MS = 80;      // nothing at all gets through
const CLICK_SETTLE_MS = 170;   // after which movement is throttled, then normal
const CLICK_MAX_PX = 8;

// Sliders, checkboxes and buttons are <input> too, and a focused slider must not
// swallow the whole keyboard — that is what stopped ` from closing the settings
// panel once the sensitivity slider had been touched.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

/** true while the keystroke belongs to a text field (menu inputs, chat box) */
export function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
  return t.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((t.type || '').toLowerCase());
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.held = new Set();          // action names currently down
    this.justPressed = new Set();
    this.lookDX = 0;
    this.lookDY = 0;
    this.stick = { x: 0, y: 0 };    // touch joystick, -1..1
    this.keyMove = { x: 0, y: 0 };
    this.keyLook = { x: 0, y: 0 };
    this.pointerLocked = false;
    this.mouseSeen = false;
    // When the browser last refused pointer lock. A timestamp, not a flag: Chrome
    // rejects a re-lock for a moment after every Esc, and a permanent flag meant
    // one press of Esc dropped the session into drag-to-look for good.
    this.lockFailedAt = 0;
    this.lockedAt = 0;         // when the pointer lock last engaged
    this.lockChanges = 0;      // how often it has engaged, shown by F3
    this.dropped = 0;          // movement events discarded as spikes
    this.clamped = 0;          // movement events cut down to the per-event ceiling
    this.lastClamp = [0, 0];
    this.lastMoveAt = 0;
    this.lastButtonAt = -1e9;   // last mouse button edge
    this._prevButtons = 0;
    this._mouseHeld = new Set();
    this.toggled = new Set();
    this.toggleMode = new Set();
    try {
      for (const a of JSON.parse(localStorage.getItem('pa.modes')) || []) this.toggleMode.add(a);
    } catch { /* nothing saved */ }
    this.binds = this._loadBinds();
    this.designBinds = this._loadBinds(DESIGN_BIND_KEY, DEFAULT_DESIGN_BINDS);
    // set while another mode owns the pointer on purpose (the level designer
    // releases it with Alt); without it every click grabs the mouse straight back
    this.suspendLock = false;
    this.rawInput = null;       // did the browser grant unaccelerated movement?
    this.lastMovement = [0, 0];
    this.textMode = false;          // chat box has focus: swallow game keys
    this.hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    this.keyboardSeen = false;
    this.editMode = false;   // while true the touch buttons are being rearranged
    this.onKeyboardDetected = null;
    this.onAction = null;           // for UI-only buttons (chat / score / weapon)
    this.sensitivity = Number(localStorage.getItem('pa.sens')) || 1;
    // Going fullscreen is what buys the right to swallow Ctrl+W and friends.
    // Remembered, so anyone who would rather keep their browser chrome can turn
    // it off once in the settings panel and be left alone about it.
    this.wantFullscreenLock = localStorage.getItem('pa.kblock') !== '0';

    this._touchMove = null;         // {id, ox, oy}
    this._touchLook = null;         // {id, x, y}
    this._mouseDrag = null;

    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
    this._bindButtons();
  }

  // ---------------------------------------------------------------- keyboard
  _bindKeyboard() {
    addEventListener('keydown', e => {
      if (this.textMode || isTyping(e)) return;

      // Suppression comes first, before both early returns below. With the mouse
      // captured the page is the application, so swallow every key - not only
      // the ones the game uses - or Ctrl+S, quick-find and F5 still reach the
      // browser mid-fight. Escape is left alone, because it is how you get the
      // mouse back.
      //
      // Crucially this also runs for auto-repeat. Holding Tab repeats, and a
      // repeat that reaches the browser walks the focus ring through the page,
      // which is what interrupted the game when the scoreboard was held open.
      if (this.pointerLocked && e.code !== 'Escape') e.preventDefault();
      else if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();

      if (e.repeat) return;            // suppressed above, but only acted on once

      const a = this.binds[e.code];
      if (a === undefined && !(e.code in LOOK_KEYS)) return;

      if (!this.keyboardSeen) {
        this.keyboardSeen = true;
        this.onKeyboardDetected?.();
      }
      if (a && UI_ACTIONS.has(a)) this.onAction?.(a);
      else if (a) this.press(a);
      if (e.code in LOOK_KEYS) this.held.add('look' + e.code);
      this._recalcKeys();
    });

    // NEVER filter keyup. A release can only ever stop something, and discarding
    // one leaves the key held forever: an arrow key stuck this way spins the view
    // at a constant rate with nothing to stop it, because keyLook is applied
    // every frame rather than consumed like a mouse delta. The old isTyping()
    // guard here dropped exactly that release whenever focus had moved to a text
    // field in between, which is one click into the chat box away.
    addEventListener('keyup', e => {
      const a = this.binds[e.code];
      if (a && !UI_ACTIONS.has(a)) this.release(a);
      if (e.code in LOOK_KEYS) this.held.delete('look' + e.code);
      this._recalcKeys();
    });

    // any way of leaving the page must not leave keys stuck down either
    const release = () => {
      this.held.clear();
      this._mouseHeld.clear();
      for (const a of this.toggled) this.held.add(a);   // a toggle is a state, not a key
      this._recalcKeys();
    };
    addEventListener('blur', release);
    addEventListener('visibilitychange', () => { if (document.hidden) release(); });
    this.releaseAll = release;
  }

  _recalcKeys() {
    this.keyMove.x = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    this.keyMove.y = (this.held.has('fwd') ? 1 : 0) - (this.held.has('back') ? 1 : 0);
    let lx = 0, ly = 0;
    for (const code in LOOK_KEYS) {
      if (this.held.has('look' + code)) { lx += LOOK_KEYS[code][0]; ly += LOOK_KEYS[code][1]; }
    }
    this.keyLook.x = lx;
    this.keyLook.y = ly;
  }

  // ------------------------------------------------------------------- mouse
  _bindMouse() {
    this.canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      this.mouseSeen = true;

      // Try to capture the mouse, but never let that get in the way of the click
      // itself. Swallowing the acquiring click is a nicety; not being able to
      // shoot is not, and the two were tangled together.
      // Ask the DOM, not the cached flag. If that flag ever goes stale — a
      // pointerlockchange missed while the tab was hidden, a lock taken by
      // something else — the cache says "not locked", every click re-requests a
      // lock the browser already holds, and every re-lock emits a settling move
      // worth tens of degrees. That is a spike per click, not just on the first.
      const reallyLocked = document.pointerLockElement === this.canvas;
      if (reallyLocked !== this.pointerLocked) this.pointerLocked = reallyLocked;

      if (!reallyLocked && !this.lockRefused && !this.suspendLock) {
        if (this.canvas.requestPointerLock) {
          this._lock();
        } else {
          this.lockFailedAt = now();
        }
      }
      if (!this.pointerLocked && this.lockRefused && !this._mouseDrag) {
        // genuinely no capture available: drag to aim, like the touch look pad
        this._mouseDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      }
    });

    addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
      if (this._mouseDrag && this._mouseDrag.id === e.pointerId) this._mouseDrag = null;
    });

    // Every button edge, on any target, for any button. The canvas listener only
    // sees what is delivered to the canvas, and a second button pressed while
    // another is held may not reach it at all - which is precisely the gesture
    // that was still shifting the view, because the settle window never opened.
    // mousedown/mouseup are listened for as well, since the middle button in
    // particular does not always produce a pointer event.
    const UP_EVENTS = new Set(['pointerup', 'mouseup', 'auxclick']);
    const edge = e => {
      this.lastButtonAt = now();
      // Read which buttons are down from the event's own mask rather than from
      // which button this particular event was about. A second button pressed
      // while another is held may never reach the canvas, so deriving the state
      // from `buttons` is the only way to see it - that is why firing while
      // holding right click did nothing.
      //
      // The mask is only trusted to *clear* an action on an actual release.
      // Some events under-report it, and one of those arriving mid-fight took
      // fire and ads away together: the gun stopped after a few rounds and the
      // sights dropped at the same moment.
      if (e && typeof e.buttons === 'number' && e.pointerType !== 'touch') {
        this._syncMouseButtons(e.buttons, UP_EVENTS.has(e.type));
      }
    };
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick']) {
      addEventListener(type, edge, true);
    }

    addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;

      // A change in which buttons are down is an edge too, and it is the only
      // signal available when the press itself is not delivered here.
      if (e.buttons !== this._prevButtons) {
        this._prevButtons = e.buttons;
        this.lastButtonAt = now();
        this._syncMouseButtons(e.buttons, false);   // a press we never saw arrive
      }

      if (this.pointerLocked) {
        this.lastMovement = [e.movementX, e.movementY];   // shown by the F3 overlay

        // Events right after a lock engages carry the jump from wherever the
        // cursor was sitting to the locked origin. That is bookkeeping, not a
        // flick, and there can be more than one of them, so the whole settling
        // window is ignored rather than a single event.
        if (now() - this.lockedAt < SETTLE_MS) { this.dropped++; return; }

        // Clamped, not discarded: real movement in the same event is kept, it
        // just cannot arrive all at once. The ceiling tightens sharply around a
        // button press, where the mouse is being disturbed by your hand.
        const sincePress = now() - this.lastButtonAt;
        if (sincePress < CLICK_DEAD_MS) { this.dropped++; return; }
        const ceiling = sincePress < CLICK_SETTLE_MS ? CLICK_MAX_PX : MAX_PX_PER_EVENT;
        const mx = clamp(e.movementX, -ceiling, ceiling);
        const my = clamp(e.movementY, -ceiling, ceiling);
        if (mx !== e.movementX || my !== e.movementY) {
          this.clamped++;
          this.lastClamp = [e.movementX, e.movementY];
        }
        this.lookDX += mx * MOUSE_SENS * this.sensitivity;
        this.lookDY += my * MOUSE_SENS * this.sensitivity;
      } else if (this._mouseDrag && this._mouseDrag.id === e.pointerId) {
        this.lookDX += (e.clientX - this._mouseDrag.x) * MOUSE_SENS * 1.6 * this.sensitivity;
        this.lookDY += (e.clientY - this._mouseDrag.y) * MOUSE_SENS * 1.6 * this.sensitivity;
        this._mouseDrag.x = e.clientX;
        this._mouseDrag.y = e.clientY;
      }
    });

    addEventListener('wheel', e => {
      if (this.textMode) return;
      this.justPressed.add(e.deltaY > 0 ? 'weaponnext' : 'weaponprev');
    }, { passive: true });

    // not input handling: this only stops the browser opening its menu over the game
    addEventListener('contextmenu', e => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      this.lockChanges++;
      if (this.pointerLocked) {
        this.lockFailedAt = 0;     // it worked, so stop treating it as refused
        this._mouseDrag = null;
        // preventDefault() cannot touch the browser's own combinations — Ctrl+W
        // closes the tab before the page hears about it. The Keyboard Lock API
        // is the only thing that can, and it only works in fullscreen, so
        // capturing the mouse takes the page fullscreen to earn it.
        this._grabKeyboard();
        this.lockedAt = now();     // ignore the settling moves that follow
        this.lookDX = this.lookDY = 0;
        try { this.canvas.releasePointerCapture(1); } catch { /* nothing captured */ }
      } else {
        try { navigator.keyboard?.unlock?.(); } catch { /* unsupported */ }
        this._mouseHeld.clear();
        this.releaseAll();         // nothing may survive losing the mouse
        this.onAction?.('pause');
      }
    });
  }

  /** Take the reserved key combinations away from the browser.
   *
   *  `navigator.keyboard.lock()` is refused outside fullscreen, so this goes
   *  fullscreen first. That is the whole price of it: there is no other way for
   *  a page to stop Ctrl+W, Ctrl+T or Ctrl+N, and leaving them live means a
   *  mistimed reach for the movement keys can close the match. Both calls are
   *  best-effort — a browser that will not play along simply keeps its
   *  shortcuts, and everything else still works. */
  _grabKeyboard() {
    const lock = () => {
      try { navigator.keyboard?.lock?.()?.catch?.(() => {}); } catch { /* unsupported */ }
    };
    if (document.fullscreenElement) { lock(); return; }
    if (!this.wantFullscreenLock) { lock(); return; }
    try {
      const p = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      if (p && p.then) p.then(lock).catch(lock);
      else lock();
    } catch { lock(); }
  }

  /** A refusal is only worth respecting for a moment; after that, try again. */
  get lockRefused() {
    return this.lockFailedAt > 0 && now() - this.lockFailedAt < LOCK_RETRY_MS;
  }

  /** True when a mouse user is playing without the pointer captured. */
  get needsMouseCapture() {
    return this.mouseSeen && !this.pointerLocked;
  }

  /** Only ever locks when a real mouse is in play — a touch device that has a
   *  keyboard attached still needs its screen for aiming. */
  requestLock() {
    if (this.suspendLock) return;
    if (this.hasTouch && !this.mouseSeen) return;
    if (this.lockRefused || !this.canvas.requestPointerLock) return;
    this._lock();
  }

  /** Raw pointer input where the browser offers it: unadjustedMovement turns off
   *  OS acceleration and, more importantly here, the recentring warps that get
   *  reported as enormous movement deltas. Not every browser accepts the option,
   *  so a rejection retries the plain form before giving up. */
  _lock() {
    let p;
    try {
      p = this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch {
      this.rawInput = false;
      p = this.canvas.requestPointerLock();
    }
    if (p && p.then) {
      p.then(() => { this.rawInput = true; }).catch(() => {
        // the browser will not give raw input, so OS acceleration stays in play
        this.rawInput = false;
        const plain = this.canvas.requestPointerLock();
        if (plain && plain.catch) plain.catch(() => { this.lockFailedAt = now(); });
      });
    }
  }

  // ------------------------------------------------------------------- touch
  _bindTouch() {
    const stickEl = document.getElementById('stick');
    const base = document.getElementById('stickbase');
    const knob = document.getElementById('stickknob');

    const place = (el, x, y) => { el.style.left = x + 'px'; el.style.top = y + 'px'; };

    this.canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault();
      const leftZone = e.clientX < innerWidth * 0.45;
      // Once a keyboard is driving movement the whole screen becomes a look pad.
      if (leftZone && !this._touchMove && !this.keyboardSeen) {
        this._touchMove = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
        stickEl.classList.add('on');
        place(base, e.clientX, e.clientY);
        place(knob, e.clientX, e.clientY);
      } else {
        this.lookStart(e);
      }
    }, { passive: false });

    this.canvas.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault();
      if (this._touchMove && this._touchMove.id === e.pointerId) {
        let dx = e.clientX - this._touchMove.ox;
        let dy = e.clientY - this._touchMove.oy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) { dx *= STICK_RADIUS / len; dy *= STICK_RADIUS / len; }
        place(knob, this._touchMove.ox + dx, this._touchMove.oy + dy);
        this.stick.x = clamp(dx / STICK_RADIUS, -1, 1);
        this.stick.y = clamp(-dy / STICK_RADIUS, -1, 1);
      } else {
        this.lookMove(e);
      }
    }, { passive: false });

    const end = e => {
      if (e.pointerType !== 'touch') return;
      if (this._touchMove && this._touchMove.id === e.pointerId) {
        this._touchMove = null;
        this.stick.x = this.stick.y = 0;
        stickEl.classList.remove('on');
      }
      this.lookEnd(e);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  /** A press. In hold mode the action stays on while the input is down; in
   *  toggle mode a press flips it and the release is ignored. */
  press(action) {
    if (this.toggleMode.has(action)) {
      if (this.toggled.has(action)) {
        this.toggled.delete(action);
        this.held.delete(action);
      } else {
        this.toggled.add(action);
        this.held.add(action);
        this.justPressed.add(action);
      }
      return;
    }
    this.held.add(action);
    this.justPressed.add(action);
  }

  release(action) {
    if (this.toggleMode.has(action)) return;   // a toggle only responds to presses
    this.held.delete(action);
  }

  /** Switching an action to hold mode drops whatever the toggle was holding. */
  setToggleMode(action, on) {
    if (on) this.toggleMode.add(action);
    else {
      this.toggleMode.delete(action);
      if (this.toggled.delete(action)) this.held.delete(action);
    }
    try {
      localStorage.setItem('pa.modes', JSON.stringify([...this.toggleMode]));
    } catch { /* private mode */ }
  }

  isToggle(action) { return this.toggleMode.has(action); }

  // ---------------------------------------------------------------- bindings
  _loadBinds(key = BIND_KEY, defaults = DEFAULT_BINDS) {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (saved && typeof saved === 'object') {
        // only keep pairs that still mean something, so an old save cannot
        // bind a key to an action the game no longer has
        const actions = new Set(Object.values(defaults));
        const out = {};
        for (const [code, action] of Object.entries(saved)) {
          if (typeof code === 'string' && actions.has(action)) out[code] = action;
        }
        if (Object.keys(out).length) return this._fillGaps(out, defaults);
      }
    } catch { /* nothing saved, or unreadable */ }
    return { ...defaults };
  }

  /** Give any action the save has never heard of its default key.
   *
   *  Without this, adding an action strands it: a returning player's map is kept
   *  verbatim, so the portal gun would have had no number key and the platform
   *  tool no key at all for anybody who had ever opened the settings panel. Only
   *  actions with no key *at all* are filled, and only onto a key nothing else
   *  is using, so a map somebody has arranged is never rearranged for them. */
  _fillGaps(map, defaults) {
    const bound = new Set(Object.values(map));
    for (const [code, action] of Object.entries(defaults)) {
      if (bound.has(action) || map[code]) continue;
      map[code] = action;
      bound.add(action);
    }
    return map;
  }

  _saveBinds(design = false) {
    const key = design ? DESIGN_BIND_KEY : BIND_KEY;
    const map = design ? this.designBinds : this.binds;
    try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* private mode */ }
  }

  /** Every key currently bound to an action, in either map. */
  keysFor(action, design = false) {
    const map = design ? this.designBinds : this.binds;
    return Object.keys(map).filter(code => map[code] === action);
  }

  /** What the level designer should do about this key, if anything. */
  designAction(code) { return this.designBinds[code]; }

  /** Point a key at an action. `replacing` is the key being changed, if this is
   *  an edit rather than an addition — an action may hold as many keys as the
   *  player adds with `+`. The code is taken off whatever else had it either
   *  way, so no key ever drives two actions at once.
   *
   *  Escape is refused: the browser owns it (it is how you get the mouse back,
   *  and how the rebinding prompt is cancelled), so binding it would be a lie. */
  bind(action, code, replacing = null, design = false) {
    if (!code || code === 'Escape') return false;
    const map = design ? this.designBinds : this.binds;
    delete map[code];
    if (replacing && replacing !== code) delete map[replacing];
    map[code] = action;
    // a rebind mid-game must not leave the old key stuck down
    this.held.delete(action);
    this.toggled.delete(action);
    this._recalcKeys();
    this._saveBinds(design);
    return true;
  }

  /** Take one key off an action, leaving its other keys alone. */
  unbind(action, code, design = false) {
    const map = design ? this.designBinds : this.binds;
    if (map[code] !== action) return false;
    delete map[code];
    this.held.delete(action);
    this.toggled.delete(action);
    this._recalcKeys();
    this._saveBinds(design);
    return true;
  }

  resetBinds(design = false) {
    if (design) {
      this.designBinds = { ...DEFAULT_DESIGN_BINDS };
      this._saveBinds(true);
      return;
    }
    this.binds = { ...DEFAULT_BINDS };
    this.held.clear();
    this.toggled.clear();
    this._recalcKeys();
    this._saveBinds();
  }

  /** Mirror the mouse's button mask into the action set. Only actions the mouse
   *  itself put there are taken away again, so a touch player holding FIRE is
   *  never disarmed by a stray mouse event on a hybrid device. */
  _syncMouseButtons(buttons, allowClear) {
    for (const [bit, action] of [[1, 'fire'], [2, 'ads']]) {
      const down = (buttons & bit) !== 0;
      const had = this._mouseHeld.has(action);
      if (down && !had) {
        this._mouseHeld.add(action);
        this.press(action);
      } else if (!down && had && allowClear) {
        this._mouseHeld.delete(action);
        this.release(action);
      }
    }
  }

  /** Touch aiming, usable from the canvas or from on top of a button. A finger
   *  that starts on FIRE must still be able to drag the view — on a phone that
   *  is the same thumb doing both. */
  lookStart(e) {
    if (!this._touchLook) this._touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  lookMove(e) {
    const l = this._touchLook;
    if (!l || l.id !== e.pointerId) return;
    this.lookDX += (e.clientX - l.x) * TOUCH_SENS * this.sensitivity;
    this.lookDY += (e.clientY - l.y) * TOUCH_SENS * this.sensitivity;
    l.x = e.clientX;
    l.y = e.clientY;
  }

  lookEnd(e) {
    if (this._touchLook && this._touchLook.id === e.pointerId) this._touchLook = null;
  }

  // --------------------------------------------------------- on-screen buttons
  _bindButtons() {
    const UI_ONLY = new Set(['chat', 'score', 'weapon', 'menu', 'layout']);
    for (const el of document.querySelectorAll('.tbtn')) {
      const name = el.dataset.btn;
      // action buttons double as look pads; the pill row at the top does not
      const aimable = !UI_ONLY.has(name);

      el.addEventListener('pointerdown', e => {
        if (this.editMode) return;            // layout editor owns the buttons
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('held');
        if (UI_ONLY.has(name)) { this.onAction?.(name); return; }
        this.press(name);
        if (aimable && e.pointerType === 'touch') this.lookStart(e);
      });

      el.addEventListener('pointermove', e => {
        if (this.editMode) return;
        if (aimable && e.pointerType === 'touch') this.lookMove(e);
      });

      const up = e => {
        if (this.editMode) return;
        e.stopPropagation();
        el.classList.remove('held');
        if (name === 'score') this.onAction?.('scoreoff');
        if (!UI_ONLY.has(name)) this.release(name);
        this.lookEnd(e);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
  }

  // ------------------------------------------------------------------- query
  down(a) { return this.held.has(a); }
  pressed(a) { return this.justPressed.has(a); }

  /** combined movement, x = strafe, y = forward, magnitude clamped to 1 */
  moveVector() {
    let x = this.keyMove.x + this.stick.x;
    let y = this.keyMove.y + this.stick.y;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  /** look delta in radians accumulated since the last frame, plus arrow keys */
  consumeLook(dt) {
    const dx = this.lookDX + this.keyLook.x * KEY_LOOK_RATE * dt;
    const dy = this.lookDY + this.keyLook.y * KEY_LOOK_RATE * dt;
    this.lookDX = this.lookDY = 0;
    return { dx, dy };
  }

  endFrame() { this.justPressed.clear(); }

  /** One multiplier for both the mouse and the touch look pad. */
  setSensitivity(v) {
    this.sensitivity = clamp(v, 0.2, 3);
    try { localStorage.setItem('pa.sens', String(this.sensitivity)); } catch { /* private mode */ }
  }

  setFullscreenLock(on) {
    this.wantFullscreenLock = !!on;
    try { localStorage.setItem('pa.kblock', on ? '1' : '0'); } catch { /* private mode */ }
    if (on && this.pointerLocked) this._grabKeyboard();
  }

  setTextMode(on) {
    this.textMode = on;
    if (on) { this.held.clear(); this._recalcKeys(); }
  }
}
