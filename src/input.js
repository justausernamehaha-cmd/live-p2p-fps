import { clamp, now } from './util.js';

// One input layer for every device. Keyboard, mouse and touch all write into the
// same state and are additive: a phone with a Bluetooth keyboard moves on WASD
// while a thumb aims. Traps behind the odd-looking code here are written up in
// claude.md ("browser input gotchas").

// Defaults only; the settings panel saves a copy that `binds` is read from.
export const DEFAULT_BINDS = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyC: 'crouch', ControlLeft: 'crouch', ControlRight: 'crouch',
  KeyF: 'fire',                       // for keyboards with no mouse
  KeyR: 'reload', KeyQ: 'lastweapon', Tab: 'score',
  Digit1: 'weapon1', Digit2: 'weapon2', Digit3: 'weapon3', Digit4: 'weapon4', Digit5: 'weapon5',
  Backquote: 'settings', Escape: 'menu'
};

// fire once on the press, never held
const UI_ACTIONS = new Set(['settings', 'menu']);

// rows in the settings panel, in order
export const BINDABLE = [
  ['fwd', 'Forward'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'],
  ['jump', 'Jump'], ['sprint', 'Sprint'], ['crouch', 'Crouch'],
  ['fire', 'Fire'], ['reload', 'Reload'], ['lastweapon', 'Last weapon'],
  ['weapon1', 'Weapon 1'], ['weapon2', 'Weapon 2'], ['weapon3', 'Weapon 3'],
  ['weapon4', 'Weapon 4 (portal gun)'], ['weapon5', 'Weapon 5 (White Out)'],
  ['score', 'Scoreboard'], ['settings', 'Open settings'], ['menu', 'Open menu']
];

// actions that can be held or latched (a latched jump is the mobile bunny hop)
export const TOGGLEABLE = [
  ['crouch', 'Crouch'], ['ads', 'Aim'], ['sprint', 'Sprint'], ['jump', 'Jump']
];

// The level designer has its own separate key map.
const DEFAULT_DESIGN_BINDS = {
  ShiftLeft: 'fast', ShiftRight: 'fast',
  Space: 'up', KeyC: 'down',
  AltLeft: 'freemouse', AltRight: 'freemouse',
  KeyQ: 'corner1', KeyE: 'corner2',
  KeyF: 'shape', KeyR: 'rotate', KeyX: 'axis',
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
const KEY_LOOK_RATE = 2.4;   // radians per second
const STICK_RADIUS = 62;
// a finger must move this far before it counts as aiming (travel is not lost)
const TOUCH_DRAG_SLOP = 5;
const LOCK_RETRY_MS = 1200;  // Chrome refuses a re-lock briefly after Esc
const SETTLE_MS = 250;       // ignore movement just after a lock engages
// A hard ceiling on how far one mouse event may turn the view. Guessing whether
// a big movement was "real" failed three times; a ceiling cannot be wrong.
const MAX_PX_PER_EVENT = 50;
// Pressing a button jolts the mouse: drop movement briefly, then throttle it.
const CLICK_DEAD_MS = 80;
const CLICK_SETTLE_MS = 170;
const CLICK_MAX_PX = 8;

// sliders and checkboxes are <input> too, and must not swallow the keyboard
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

/** true while the keystroke belongs to a text field */
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
    this.lockFailedAt = 0;     // a timestamp, never a permanent flag
    this.lockedAt = 0;
    this.lockChanges = 0;      // F3 readouts
    this.dropped = 0;
    this.clamped = 0;
    this.lastClamp = [0, 0];
    this.lastMoveAt = 0;
    this.lastButtonAt = -1e9;
    this._prevButtons = 0;
    this._mouseHeld = new Set();
    this.toggled = new Set();
    this.toggleMode = new Set();
    // Actions forced to hold mode for now (the portal gun's right trigger: a
    // latched AIM would make every second tap place nothing).
    this.holdOverride = new Set();
    try {
      for (const a of JSON.parse(localStorage.getItem('pa.modes')) || []) this.toggleMode.add(a);
    } catch { /* nothing saved */ }
    this.binds = this._loadBinds();
    this.designBinds = this._loadBinds(DESIGN_BIND_KEY, DEFAULT_DESIGN_BINDS);
    // set while another mode owns the pointer on purpose (designer's Alt, menus)
    this.suspendLock = false;
    this.rawInput = null;
    this.lastMovement = [0, 0];
    this.textMode = false;          // chat box has focus
    this.hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    this.keyboardSeen = false;
    this._editMode = false;
    this.onKeyboardDetected = null;
    this.onAction = null;
    this.sensitivity = Number(localStorage.getItem('pa.sens')) || 1;
    // Going fullscreen is what lets keyboard.lock() swallow Ctrl+W and friends.
    this.wantFullscreenLock = localStorage.getItem('pa.kblock') !== '0';
    this.keyboardLocked = false;
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        if (this.wantFullscreenLock && this.pointerLocked) this._grabKeyboard();
      } else {
        this.keyboardLocked = false;
      }
    });

    // Every finger on the glass, by pointerId. Nothing about touch lives outside
    // this map, and every way a finger can leave drops its entry.
    this._touch = new Map();
    this._touchSeq = 0;
    this._mouseDrag = null;
    this._stick = {
      el: document.getElementById('stick'),
      base: document.getElementById('stickbase'),
      knob: document.getElementById('stickknob')
    };

    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
    this._bindTouchEnd();
    this._bindButtons();
  }

  /** Opening the layout editor lets go of every finger, or one resting on a
   *  button would own the look pad for ever. */
  get editMode() { return this._editMode; }
  set editMode(v) {
    const on = !!v;
    if (on === this._editMode) return;
    this._editMode = on;
    this.dropTouches();
  }

  // ---------------------------------------------------------------- keyboard
  _bindKeyboard() {
    addEventListener('keydown', e => {
      if (this.textMode || isTyping(e)) return;

      // Suppress before the early returns, auto-repeat included: with the mouse
      // captured the page owns every key but Escape, and a repeating Tab that
      // reaches the browser walks focus through the page.
      if (this.pointerLocked && e.code !== 'Escape') e.preventDefault();
      else if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();

      if (e.repeat) return;

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

    // NEVER filter keyup: a discarded release leaves a key held for ever.
    addEventListener('keyup', e => {
      const a = this.binds[e.code];
      if (a && !UI_ACTIONS.has(a)) this.release(a);
      if (e.code in LOOK_KEYS) this.held.delete('look' + e.code);
      this._recalcKeys();
    });

    // leaving the page releases everything (a backgrounded phone sends no pointerup)
    const release = () => {
      this.held.clear();
      this._mouseHeld.clear();
      this.dropTouches();
      for (const a of this.toggled) this.held.add(a);   // a toggle is a state, not a key
      this._recalcKeys();
    };
    addEventListener('blur', release);
    addEventListener('pagehide', release);
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

      // Ask the DOM, not the cached flag: a stale flag re-requests a lock the
      // browser already holds on every click, and each re-lock jolts the view.
      const reallyLocked = document.pointerLockElement === this.canvas;
      if (reallyLocked !== this.pointerLocked) this.pointerLocked = reallyLocked;

      // Every click, since fullscreen and keyboard.lock() need a live gesture.
      if (!this.suspendLock && !this.shortcutsBlocked) this._grabKeyboard();

      if (!reallyLocked && !this.lockRefused && !this.suspendLock) {
        if (this.canvas.requestPointerLock) {
          this._lock();
        } else {
          this.lockFailedAt = now();
        }
      }
      if (!this.pointerLocked && this.lockRefused && !this._mouseDrag) {
        // no capture available: drag to aim
        this._mouseDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      }
    });

    addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
      if (this._mouseDrag && this._mouseDrag.id === e.pointerId) this._mouseDrag = null;
    });

    // Every button edge on the window, capture phase: a second button pressed
    // while one is held may never reach the canvas. State comes from the event's
    // `buttons` mask, trusted to clear an action only on a real release.
    const UP_EVENTS = new Set(['pointerup', 'mouseup', 'auxclick']);
    const edge = e => {
      this.lastButtonAt = now();
      if (e && typeof e.buttons === 'number' && e.pointerType !== 'touch') {
        this._syncMouseButtons(e.buttons, UP_EVENTS.has(e.type));
      }
    };
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick']) {
      addEventListener(type, edge, true);
    }

    addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;

      // a changed mask is an edge too (a press we never saw arrive)
      if (e.buttons !== this._prevButtons) {
        this._prevButtons = e.buttons;
        this.lastButtonAt = now();
        this._syncMouseButtons(e.buttons, false);
      }

      if (this.pointerLocked) {
        this.lastMovement = [e.movementX, e.movementY];
        if (now() - this.lockedAt < SETTLE_MS) { this.dropped++; return; }

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

    addEventListener('contextmenu', e => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      this.lockChanges++;
      if (this.pointerLocked) {
        this.lockFailedAt = 0;
        this._mouseDrag = null;
        this._grabKeyboard();
        this.lockedAt = now();
        this.lookDX = this.lookDY = 0;
        try { this.canvas.releasePointerCapture(1); } catch { /* nothing captured */ }
      } else {
        this.keyboardLocked = false;
        try { navigator.keyboard?.unlock?.(); } catch { /* unsupported */ }
        this._mouseHeld.clear();
        this.releaseAll();         // nothing survives losing the mouse
        this.onAction?.('pause');
      }
    });
  }

  /** Take Ctrl+W and friends from the browser: keyboard.lock() only works in
   *  element fullscreen (F11 is not that), so go fullscreen first. Best effort. */
  _grabKeyboard() {
    if (!this.wantFullscreenLock) return;
    const lock = () => {
      const k = navigator.keyboard;
      if (!k || !k.lock) { this.keyboardLocked = false; return; }
      try {
        const p = k.lock();
        if (p && p.then) p.then(() => { this.keyboardLocked = true; })
                          .catch(() => { this.keyboardLocked = false; });
        else this.keyboardLocked = true;
      } catch { this.keyboardLocked = false; }
    };
    if (document.fullscreenElement) { lock(); return; }
    try {
      const p = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      if (p && p.then) p.then(lock).catch(() => { this.keyboardLocked = false; });
      else lock();
    } catch { this.keyboardLocked = false; }
  }

  /** Are the reserved combinations really ours right now? */
  get shortcutsBlocked() {
    return !!(this.keyboardLocked && document.fullscreenElement);
  }

  get lockRefused() {
    return this.lockFailedAt > 0 && now() - this.lockFailedAt < LOCK_RETRY_MS;
  }

  get needsMouseCapture() {
    return this.mouseSeen && !this.pointerLocked;
  }

  /** Lock only when a real mouse is in play. `force` (a click on the hint)
   *  clears a recent refusal instead of waiting it out. */
  requestLock(force = false) {
    if (this.suspendLock) return;
    if (this.hasTouch && !this.mouseSeen) return;
    if (force) this.lockFailedAt = 0;
    if (this.lockRefused || !this.canvas.requestPointerLock) return;
    this._lock();
  }

  /** Raw (unaccelerated) movement where offered, else the plain lock. */
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
        this.rawInput = false;
        const plain = this.canvas.requestPointerLock();
        if (plain && plain.catch) plain.catch(() => { this.lockFailedAt = now(); });
      });
    }
  }

  // ------------------------------------------------------------------- touch
  /** Track a finger. `role` is 'stick', 'look' or 'none'. */
  _touchAdd(e, role, extra = {}) {
    if (this._touch.has(e.pointerId)) return this._touch.get(e.pointerId);
    const t = {
      id: e.pointerId, role, seq: ++this._touchSeq, seen: now(),
      ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY,
      drag: false, dseq: 0,   // aiming yet, and the order it started aiming in
      btn: null, el: null, ...extra
    };
    this._touch.set(e.pointerId, t);
    return t;
  }

  /** Forget a finger and release what it held. Safe for an untracked id. */
  _touchDrop(id) {
    const t = this._touch.get(id);
    if (!t) return;
    this._touch.delete(id);
    if (t.role === 'stick') {
      this.stick.x = this.stick.y = 0;
      this._stick.el?.classList.remove('on');
    }
    if (t.el) t.el.classList.remove('held');
    if (t.btn) this.release(t.btn);
  }

  dropTouches() {
    for (const id of [...this._touch.keys()]) this._touchDrop(id);
    this.stick.x = this.stick.y = 0;
    this._stick.el?.classList.remove('on');
  }

  _stickTouch() {
    for (const t of this._touch.values()) if (t.role === 'stick') return t;
    return null;
  }

  /** The finger driving the view: the first to start DRAGGING, not the first to
   *  land, so a thumb resting on FIRE never owns the view. */
  _lookTouch() {
    let best = null;
    for (const t of this._touch.values()) {
      if (t.role === 'look' && t.drag && (!best || t.dseq < best.dseq)) best = t;
    }
    return best;
  }

  _bindTouch() {
    const { el: stickEl, base, knob } = this._stick;
    const place = (el, x, y) => { el.style.left = x + 'px'; el.style.top = y + 'px'; };

    this.canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault();
      const leftZone = e.clientX < innerWidth * 0.45;
      // with a keyboard attached the whole screen is a look pad
      if (leftZone && !this._stickTouch() && !this.keyboardSeen) {
        this._touchAdd(e, 'stick');
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
      const t = this._touch.get(e.pointerId);
      if (t) t.seen = now();
      if (t && t.role === 'stick') {
        let dx = e.clientX - t.ox;
        let dy = e.clientY - t.oy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) { dx *= STICK_RADIUS / len; dy *= STICK_RADIUS / len; }
        place(knob, t.ox + dx, t.oy + dy);
        this.stick.x = clamp(dx / STICK_RADIUS, -1, 1);
        this.stick.y = clamp(-dy / STICK_RADIUS, -1, 1);
      } else {
        this.lookMove(e);
      }
    }, { passive: false });
  }

  /** Four ways a finger stops counting: its own pointerup/cancel (on the window,
   *  capture phase), the page losing focus, the layout editor opening, and a
   *  reconcile against TouchEvent.touches that reaps the stalest extras. */
  _bindTouchEnd() {
    const end = e => { if (e.pointerType === 'touch') this._touchDrop(e.pointerId); };
    addEventListener('pointerup', end, true);
    addEventListener('pointercancel', end, true);

    const reconcile = e => {
      const live = e.touches ? e.touches.length : 0;
      if (this._touch.size <= live) return;
      const stale = [...this._touch.values()].sort((a, b) => a.seen - b.seen || a.seq - b.seq);
      for (const t of stale) {
        if (this._touch.size <= live) break;
        this._touchDrop(t.id);
      }
    };
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      addEventListener(type, reconcile, { capture: true, passive: true });
    }
  }

  /** Hold mode: on while down. Toggle mode: a press flips it, releases ignored. */
  press(action) {
    if (this._latches(action)) {
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
    if (this._latches(action)) return;
    this.held.delete(action);
  }

  _latches(action) {
    return this.toggleMode.has(action) && !this.holdOverride.has(action);
  }

  /** Force hold mode for now, dropping whatever a latch was holding. */
  setHoldOverride(action, on) {
    if (on === this.holdOverride.has(action)) return;
    if (on) {
      this.holdOverride.add(action);
      if (this.toggled.delete(action)) this.held.delete(action);
    } else {
      this.holdOverride.delete(action);
      this.held.delete(action);
    }
    this._recalcKeys();
  }

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
  /** A saved map, keeping only pairs that still name real actions, with any
   *  action the save has never heard of given its default key if that key is free. */
  _loadBinds(key = BIND_KEY, defaults = DEFAULT_BINDS) {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (saved && typeof saved === 'object') {
        const actions = new Set(Object.values(defaults));
        const out = {};
        for (const [code, action] of Object.entries(saved)) {
          if (typeof code === 'string' && actions.has(action)) out[code] = action;
        }
        if (Object.keys(out).length) {
          const bound = new Set(Object.values(out));
          for (const [code, action] of Object.entries(defaults)) {
            if (bound.has(action) || out[code]) continue;
            out[code] = action;
            bound.add(action);
          }
          return out;
        }
      }
    } catch { /* nothing saved, or unreadable */ }
    return { ...defaults };
  }

  _saveBinds(design = false) {
    const key = design ? DESIGN_BIND_KEY : BIND_KEY;
    const map = design ? this.designBinds : this.binds;
    try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* private mode */ }
  }

  keysFor(action, design = false) {
    const map = design ? this.designBinds : this.binds;
    return Object.keys(map).filter(code => map[code] === action);
  }

  designAction(code) { return this.designBinds[code]; }

  /** Point a key at an action (`replacing` = the key being changed, else an
   *  addition). The key leaves any other action. Escape belongs to the browser. */
  bind(action, code, replacing = null, design = false) {
    if (!code || code === 'Escape') return false;
    const map = design ? this.designBinds : this.binds;
    delete map[code];
    if (replacing && replacing !== code) delete map[replacing];
    map[code] = action;
    this._rebound(action, design);
    return true;
  }

  unbind(action, code, design = false) {
    const map = design ? this.designBinds : this.binds;
    if (map[code] !== action) return false;
    delete map[code];
    this._rebound(action, design);
    return true;
  }

  /** After a rebind: nothing may be left stuck down. */
  _rebound(action, design) {
    this.held.delete(action);
    this.toggled.delete(action);
    this._recalcKeys();
    this._saveBinds(design);
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

  /** Mirror the mouse button mask. Only actions the mouse put there are taken
   *  away, so a stray mouse event cannot disarm a touch player. */
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

  /** Touch aiming, from the canvas or from on top of a button. */
  lookStart(e) { this._touchAdd(e, 'look'); }

  lookMove(e) {
    const l = this._touch.get(e.pointerId);
    if (!l || l.role !== 'look') return;
    l.seen = now();
    // crossing the slop starts aiming, rewound to the landing point so no travel is lost
    if (!l.drag && Math.hypot(e.clientX - l.ox, e.clientY - l.oy) > TOUCH_DRAG_SLOP) {
      l.drag = true;
      l.dseq = ++this._touchSeq;
      l.x = l.ox;
      l.y = l.oy;
    }
    // only the owner turns the view, but every look finger's position is tracked
    if (l.drag && this._lookTouch() === l) {
      this.lookDX += (e.clientX - l.x) * TOUCH_SENS * this.sensitivity;
      this.lookDY += (e.clientY - l.y) * TOUCH_SENS * this.sensitivity;
    }
    l.x = e.clientX;
    l.y = e.clientY;
  }

  // --------------------------------------------------------- on-screen buttons
  _bindButtons() {
    const UI_ONLY = new Set(['chat', 'score', 'weapon', 'menu', 'layout']);
    for (const el of document.querySelectorAll('.tbtn')) {
      const name = el.dataset.btn;
      const aimable = !UI_ONLY.has(name);   // action buttons double as look pads

      el.addEventListener('pointerdown', e => {
        if (this.editMode) return;
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('held');
        if (UI_ONLY.has(name)) this.onAction?.(name);
        else this.press(name);
        // tracked like any finger, so any backstop can release it
        if (e.pointerType === 'touch') {
          this._touchAdd(e, aimable ? 'look' : 'none',
                         { btn: UI_ONLY.has(name) ? null : name, el });
        }
      });

      el.addEventListener('pointermove', e => {
        if (this.editMode) return;
        if (aimable && e.pointerType === 'touch') this.lookMove(e);
      });

      const up = e => {
        e.stopPropagation();
        if (e.pointerType === 'touch') { this._touchDrop(e.pointerId); return; }
        el.classList.remove('held');
        if (this.editMode) return;
        if (name === 'score') this.onAction?.('scoreoff');
        if (!UI_ONLY.has(name)) this.release(name);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
  }

  // ------------------------------------------------------------------- query
  down(a) { return this.held.has(a); }
  pressed(a) { return this.justPressed.has(a); }

  /** x = strafe, y = forward, magnitude clamped to 1 */
  moveVector() {
    let x = this.keyMove.x + this.stick.x;
    let y = this.keyMove.y + this.stick.y;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  /** look delta in radians since the last frame, plus arrow keys */
  consumeLook(dt) {
    const dx = this.lookDX + this.keyLook.x * KEY_LOOK_RATE * dt;
    const dy = this.lookDY + this.keyLook.y * KEY_LOOK_RATE * dt;
    this.lookDX = this.lookDY = 0;
    return { dx, dy };
  }

  endFrame() { this.justPressed.clear(); }

  setSensitivity(v) {
    this.sensitivity = clamp(v, 0.2, 3);
    try { localStorage.setItem('pa.sens', String(this.sensitivity)); } catch { /* private mode */ }
  }

  setFullscreenLock(on) {
    this.wantFullscreenLock = !!on;
    try { localStorage.setItem('pa.kblock', on ? '1' : '0'); } catch { /* private mode */ }
    if (on) this._grabKeyboard();      // the checkbox click is the gesture
    else {
      this.keyboardLocked = false;
      try { navigator.keyboard?.unlock?.(); } catch { /* unsupported */ }
    }
  }

  setTextMode(on) {
    this.textMode = on;
    if (on) { this.held.clear(); this._recalcKeys(); }
  }
}
