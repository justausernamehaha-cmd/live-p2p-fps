import { clamp } from './util.js';

// One input layer for every device. Keyboard, mouse, and touch all write into
// the same state, and they are additive: a phone with a Bluetooth keyboard
// drives movement from WASD while the thumb on the right half still aims.

const KEY_ACTIONS = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyC: 'crouch', ControlLeft: 'fire', ControlRight: 'fire', KeyF: 'fire',
  KeyR: 'reload', KeyQ: 'lastweapon', Tab: 'score',
  Digit1: 'weapon1', Digit2: 'weapon2', Digit3: 'weapon3'
};

const LOOK_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const MOUSE_SENS = 0.0022;   // radians per pixel
const TOUCH_SENS = 0.0042;
const KEY_LOOK_RATE = 2.4;   // radians per second for arrow-key aiming
const STICK_RADIUS = 62;

/** true while the keystroke belongs to a text field (menu inputs, chat box) */
export function isTyping(e) {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
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
    this.lockFailed = false;   // set when the browser refuses pointer lock
    this.textMode = false;          // chat box has focus: swallow game keys
    this.hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    this.keyboardSeen = false;
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

    addEventListener('keyup', e => {
      if (isTyping(e)) return;
      const a = KEY_ACTIONS[e.code];
      if (a) this.held.delete(a);
      if (e.code in LOOK_KEYS) this.held.delete('look' + e.code);
      this._recalcKeys();
    });

    // a lost focus must not leave keys stuck down
    addEventListener('blur', () => { this.held.clear(); this._recalcKeys(); });
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
      if (!this.pointerLocked && !this.lockFailed) {
        if (this.canvas.requestPointerLock) {
          // Chrome rejects the promise when the document isn't focused, and
          // iPadOS has no pointer lock at all — both land here.
          const p = this.canvas.requestPointerLock();
          if (p && p.catch) p.catch(() => { this.lockFailed = true; });
          return;                       // this click only grabs the mouse
        }
        this.lockFailed = true;
      }
      if (this.lockFailed && !this._mouseDrag) {
        // no pointer lock: drag to aim, the way the touch look pad works
        this._mouseDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
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
      if (!this.pointerLocked) { this.held.delete('fire'); this.onAction?.('pause'); }
    });
  }

  /** Only ever locks when a real mouse is in play — a touch device that has a
   *  keyboard attached still needs its screen for aiming. */
  requestLock() {
    if (this.hasTouch && !this.mouseSeen) return;
    if (this.lockFailed || !this.canvas.requestPointerLock) return;
    const p = this.canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { this.lockFailed = true; });
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
      } else if (!this._touchLook) {
        this._touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY };
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
      } else if (this._touchLook && this._touchLook.id === e.pointerId) {
        this.lookDX += (e.clientX - this._touchLook.x) * TOUCH_SENS * this.sensitivity;
        this.lookDY += (e.clientY - this._touchLook.y) * TOUCH_SENS * this.sensitivity;
        this._touchLook.x = e.clientX;
        this._touchLook.y = e.clientY;
      }
    }, { passive: false });

    const end = e => {
      if (e.pointerType !== 'touch') return;
      if (this._touchMove && this._touchMove.id === e.pointerId) {
        this._touchMove = null;
        this.stick.x = this.stick.y = 0;
        stickEl.classList.remove('on');
      }
      if (this._touchLook && this._touchLook.id === e.pointerId) this._touchLook = null;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  // --------------------------------------------------------- on-screen buttons
  _bindButtons() {
    const UI_ONLY = new Set(['chat', 'score', 'weapon', 'menu']);
    for (const el of document.querySelectorAll('.tbtn')) {
      const name = el.dataset.btn;
      el.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('held');
        if (UI_ONLY.has(name)) { this.onAction?.(name); return; }
        this.held.add(name);
        this.justPressed.add(name);
      });
      const up = e => {
        e.stopPropagation();
        el.classList.remove('held');
        if (name === 'score') this.onAction?.('scoreoff');
        if (!UI_ONLY.has(name)) this.held.delete(name);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
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

  setTextMode(on) {
    this.textMode = on;
    if (on) { this.held.clear(); this._recalcKeys(); }
  }
}
