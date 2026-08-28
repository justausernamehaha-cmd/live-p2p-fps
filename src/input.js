import { clamp, now } from './util.js';

// One input layer for every device. Keyboard, mouse, and touch all write into
// the same state, and they are additive: a phone with a Bluetooth keyboard
// drives movement from WASD while the thumb on the right half still aims.

const KEY_ACTIONS = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyC: 'crouch', ControlLeft: 'crouch', ControlRight: 'crouch',
  KeyF: 'fire',                       // keyboard-only fallback when there is no mouse
  KeyR: 'reload', KeyQ: 'lastweapon', Tab: 'score',
  Digit1: 'weapon1', Digit2: 'weapon2', Digit3: 'weapon3'
};

const LOOK_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const MOUSE_SENS = 0.0022;   // radians per pixel
const TOUCH_SENS = 0.0042;
const KEY_LOOK_RATE = 2.4;   // radians per second for arrow-key aiming
const STICK_RADIUS = 62;
const LOCK_RETRY_MS = 1200;  // Chrome refuses a re-lock briefly after every Esc
const SPIKE_PX = 400;        // no real flick moves this far in one event

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
    this.freshLock = false;
    this.lastMovement = [0, 0];
    this.textMode = false;          // chat box has focus: swallow game keys
    this.hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    this.keyboardSeen = false;
    this.editMode = false;   // while true the touch buttons are being rearranged
    this.onKeyboardDetected = null;
    this.onAction = null;           // for UI-only buttons (chat / score / weapon)
    this.sensitivity = Number(localStorage.getItem('pa.sens')) || 1;

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
      if (e.repeat) return;
      if (this.textMode || isTyping(e)) return;
      const a = KEY_ACTIONS[e.code];
      if (a === undefined && !(e.code in LOOK_KEYS)) return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();

      if (!this.keyboardSeen) {
        this.keyboardSeen = true;
        this.onKeyboardDetected?.();
      }
      if (a) {
        this.held.add(a);
        this.justPressed.add(a);
      }
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
      const a = KEY_ACTIONS[e.code];
      if (a) this.held.delete(a);
      if (e.code in LOOK_KEYS) this.held.delete('look' + e.code);
      this._recalcKeys();
    });

    // any way of leaving the page must not leave keys stuck down either
    const release = () => { this.held.clear(); this._recalcKeys(); };
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
      if (!this.pointerLocked && !this.lockRefused) {
        if (this.canvas.requestPointerLock) {
          const p = this.canvas.requestPointerLock();
          if (p && p.catch) p.catch(() => { this.lockFailedAt = now(); });
        } else {
          this.lockFailedAt = now();
        }
      }
      if (!this.pointerLocked && this.lockRefused && !this._mouseDrag) {
        // genuinely no capture available: drag to aim, like the touch look pad
        this._mouseDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      }
      if (e.button === 0) { this.held.add('fire'); this.justPressed.add('fire'); }
      if (e.button === 2) { this.held.add('ads'); this.justPressed.add('ads'); }
    });

    addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0) this.held.delete('fire');
      if (e.button === 2) this.held.delete('ads');
      if (this._mouseDrag && this._mouseDrag.id === e.pointerId) this._mouseDrag = null;
    });

    addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      if (this.pointerLocked) {
        this.lastMovement = [e.movementX, e.movementY];   // shown by the F3 overlay

        // The first event after a lock engages carries the whole jump from
        // wherever the cursor was sitting to the locked origin. It is not a
        // flick, it is bookkeeping, and acting on it snaps the view a long way
        // in a direction that stays the same for as long as you keep clicking
        // in the same spot. Drop it outright.
        if (this.freshLock) { this.freshLock = false; return; }
        if (Math.abs(e.movementX) > SPIKE_PX || Math.abs(e.movementY) > SPIKE_PX) return;

        this.lookDX += e.movementX * MOUSE_SENS * this.sensitivity;
        this.lookDY += e.movementY * MOUSE_SENS * this.sensitivity;
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
      if (this.pointerLocked) {
        this.lockFailedAt = 0;     // it worked, so stop treating it as refused
        this._mouseDrag = null;
        this.freshLock = true;     // ignore the settling event that follows
        this.lookDX = this.lookDY = 0;
        try { this.canvas.releasePointerCapture(1); } catch { /* nothing captured */ }
      } else {
        this.releaseAll();         // nothing may survive losing the mouse
        this.onAction?.('pause');
      }
    });
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
    if (this.hasTouch && !this.mouseSeen) return;
    if (this.lockRefused || !this.canvas.requestPointerLock) return;
    const p = this.canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { this.lockFailedAt = now(); });
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
        this.held.add(name);
        this.justPressed.add(name);
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
        if (!UI_ONLY.has(name)) this.held.delete(name);
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

  setTextMode(on) {
    this.textMode = on;
    if (on) { this.held.clear(); this._recalcKeys(); }
  }
}
