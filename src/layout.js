import { clamp } from './util.js';
import { BINDABLE, TOGGLEABLE, DESIGN_BINDABLE } from './input.js';

// The settings panel: drag and resize the touch buttons (stored as viewport
// fractions), hold/toggle modes, and key rebinding.

const KEY = 'pa.layout';
const MIN = 0.55, MAX = 2.0;

export class Layout {
  constructor() {
    this.data = this._load();
    this.editing = false;
    this.selected = null;
    this._drag = null;

    this.buttons = [...document.querySelectorAll('#tbuttons .tbtn, #tside .tbtn')];
    this.panel = document.getElementById('editpanel');
    this.slider = document.getElementById('sizeslider');
    this.sizeval = document.getElementById('sizeval');

    this.slider.addEventListener('input', () => {
      if (!this.selected) return;
      const s = Number(this.slider.value) / 100;
      this._entry(this.selected).s = clamp(s, MIN, MAX);
      this.sizeval.textContent = Math.round(s * 100) + '%';
      this.apply();
      this._save();
    });

    document.getElementById('resetlayout').addEventListener('click', () => this.reset());

    this._buildModeRows();
    this._buildKeyRows('keybinds', BINDABLE, false);
    this._buildKeyRows('designbinds', DESIGN_BINDABLE, true);
    for (const [id, design] of [['resetbinds', false], ['resetdesignbinds', true]]) {
      document.getElementById(id).addEventListener('click', () => {
        this._capturing = null;
        this.onResetBinds?.(design);
        this.showBinds();
      });
    }
    // While a row is armed the next key is a binding and nothing else: capture
    // phase on the window, ahead of the game's and the designer's own handlers.
    addEventListener('keydown', e => {
      const cap = this._capturing;
      if (!cap) return;
      e.preventDefault();
      e.stopPropagation();
      this._capturing = null;
      if (e.code === 'Escape') { /* cancelled */ }
      else if ((e.code === 'Backspace' || e.code === 'Delete') && cap.replacing) {
        this.onUnbind?.(cap.action, cap.replacing, cap.design);
      } else {
        this.onBind?.(cap.action, e.code, cap.replacing, cap.design);
      }
      this.showBinds();
    }, true);

    for (const el of this.buttons) this._bindDrag(el);
    this.apply();
    addEventListener('resize', () => this.apply());
  }

  _buildModeRows() {
    const wrap = document.getElementById('moderows');
    wrap.innerHTML = '';
    for (const [action, label] of TOGGLEABLE) {
      const row = document.createElement('div');
      row.className = 'esize moderow';
      row.dataset.action = action;
      row.textContent = label;
      const modes = document.createElement('span');
      modes.className = 'modes';
      for (const mode of ['hold', 'toggle']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.action = action;
        b.dataset.mode = mode;
        b.textContent = mode.toUpperCase();
        b.addEventListener('click', () => {
          this.onMode?.(action, mode === 'toggle');
          this.showModes();
        });
        modes.appendChild(b);
      }
      row.appendChild(modes);
      wrap.appendChild(row);
    }
    this.modeButtons = [...wrap.querySelectorAll('.modes button')];
  }

  /** One row per action: a button per bound key, and `+` to add another. */
  _buildKeyRows(hostId, list, design) {
    const wrap = document.getElementById(hostId);
    wrap.innerHTML = '';
    this.keyRows = this.keyRows || new Map();
    for (const [action, label] of list) {
      const row = document.createElement('div');
      row.className = 'bindrow';
      row.dataset.action = action;
      const name = document.createElement('span');
      name.className = 'bindname';
      name.textContent = label;
      const keys = document.createElement('span');
      keys.className = 'bindkeys';
      row.append(name, keys);
      wrap.appendChild(row);
      this.keyRows.set((design ? 'design:' : '') + action, { host: keys, action, design });
    }
  }

  /** Arm a row. `replacing` is the key being changed, or null to add one. */
  _capture(action, replacing, design) {
    this._capturing = { action, replacing, design };
    this.showBinds();
  }

  showBinds() {
    if (!this.keyRows) return;
    const cap = this._capturing;
    for (const { host, action, design } of this.keyRows.values()) {
      host.innerHTML = '';
      const mine = !!cap && cap.action === action && !!cap.design === !!design;
      const keys = this.keysFor?.(action, design) ?? [];
      for (const code of keys) {
        const armed = mine && cap.replacing === code;
        host.appendChild(this._keyButton(
          armed ? 'press a key…' : keyLabel(code), 'bindkey', armed,
          () => this._capture(action, code, design)));
      }
      if (!keys.length) {
        const none = document.createElement('span');
        none.className = 'bindnone';
        none.textContent = '—';
        host.appendChild(none);
      }
      const adding = mine && cap.replacing === null;
      const plus = this._keyButton(adding ? 'press a key…' : '+', 'bindadd', adding,
                                   () => this._capture(action, null, design));
      plus.title = 'add another key for this action';
      host.appendChild(plus);
    }
  }

  _keyButton(text, cls, armed, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls + (armed ? ' arming' : '');
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }

  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  _entry(name) {
    if (!this.data[name]) {
      // start from wherever the CSS puts it, so nothing jumps
      const el = this.buttons.find(b => b.dataset.btn === name);
      const r = el.getBoundingClientRect();
      this.data[name] = {
        x: (r.left + r.width / 2) / innerWidth,
        y: (r.top + r.height / 2) / innerHeight,
        s: 1
      };
    }
    return this.data[name];
  }

  apply() {
    for (const el of this.buttons) {
      const d = this.data[el.dataset.btn];
      if (!d) { el.style.position = el.style.left = el.style.top = el.style.transform = ''; continue; }
      // clamped on-screen, so a layout from a big screen still fits a small one
      const x = clamp(d.x, 0.04, 0.96) * innerWidth;
      const y = clamp(d.y, 0.04, 0.96) * innerHeight;
      el.style.position = 'fixed';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.transform = `translate(-50%, -50%) scale(${d.s})`;
    }
  }

  _bindDrag(el) {
    el.addEventListener('pointerdown', e => {
      if (!this.editing) return;
      e.preventDefault();
      e.stopPropagation();
      this.select(el.dataset.btn);
      const d = this._entry(el.dataset.btn);
      this._drag = {
        id: e.pointerId, el,
        dx: d.x * innerWidth - e.clientX,
        dy: d.y * innerHeight - e.clientY
      };
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }, true);

    el.addEventListener('pointermove', e => {
      if (!this.editing || !this._drag || this._drag.id !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      const d = this._entry(el.dataset.btn);
      d.x = clamp((e.clientX + this._drag.dx) / innerWidth, 0.04, 0.96);
      d.y = clamp((e.clientY + this._drag.dy) / innerHeight, 0.04, 0.96);
      this.apply();
    }, true);

    const end = e => {
      if (!this._drag || this._drag.id !== e.pointerId) return;
      this._drag = null;
      this._save();
    };
    el.addEventListener('pointerup', end, true);
    el.addEventListener('pointercancel', end, true);
  }

  showModes() {
    for (const el of this.modeButtons) {
      const on = this.isToggle?.(el.dataset.action) ?? false;
      el.classList.toggle('on', (el.dataset.mode === 'toggle') === on);
    }
  }

  select(name) {
    this.selected = name;
    document.body.classList.add('has-selection');
    for (const row of document.querySelectorAll('.moderow')) {
      row.classList.toggle('active', row.dataset.action === name);
    }
    this.showModes();
    for (const el of this.buttons) el.classList.toggle('selected', el.dataset.btn === name);
    const d = this._entry(name);
    this.slider.disabled = false;
    this.slider.value = Math.round(d.s * 100);
    this.sizeval.textContent = Math.round(d.s * 100) + '%';
  }

  _deselect() {
    this.selected = null;
    document.body.classList.remove('has-selection');
    this.slider.disabled = true;
    this.sizeval.textContent = '--';
    for (const row of document.querySelectorAll('.moderow')) row.classList.remove('active');
    for (const el of this.buttons) el.classList.remove('selected');
  }

  enter() {
    this.editing = true;
    this._capturing = null;
    this.showModes();
    this.showBinds();
    document.body.classList.add('editing');
    this.panel.classList.remove('hidden');
    this._deselect();
  }

  exit() {
    this.editing = false;
    this._capturing = null;
    this._drag = null;
    document.body.classList.remove('editing');
    this.panel.classList.add('hidden');
    this._deselect();
    this._save();
  }

  reset() {
    this.data = {};
    this._deselect();
    this.apply();
    this._save();
  }
}

/** `KeyW` -> `W`, `ShiftLeft` -> `Shift L`. */
function keyLabel(code) {
  if (!code) return '—';
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(code))) return 'Num ' + m[1];
  if ((m = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code))) {
    return (m[1] === 'Control' ? 'Ctrl' : m[1]) + ' ' + (m[2] === 'Left' ? 'L' : 'R');
  }
  return ({
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backquote: '`', Equal: '=', Escape: 'Esc',
    Minus: '-', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    CapsLock: 'Caps', Backspace: 'Bksp', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Backslash: '\\'
  })[code] || code;
}
