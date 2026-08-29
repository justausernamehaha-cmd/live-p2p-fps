import { clamp } from './util.js';
import { BINDABLE, TOGGLEABLE } from './input.js';

// Lets a phone player drag the on-screen buttons around and resize them, because
// no single fixed layout suits every hand and every screen. Positions are stored
// as viewport fractions so they survive rotation and a change of device.

const KEY = 'pa.layout';
const MIN = 0.55, MAX = 2.0;

export class Layout {
  constructor() {
    this.data = this._load();
    this.editing = false;
    this.selected = null;
    this._drag = null;
    this.onSelect = null;

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
    this._buildKeyRows();

    for (const el of this.buttons) this._bindDrag(el);
    this.apply();
    addEventListener('resize', () => this.apply());
  }

  /** One hold-or-toggle row per action that can be latched. Built here rather
   *  than written into the page so adding an action is a one-line change. */
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

  /** The keyboard half of the panel: one row per action, click to rebind. */
  _buildKeyRows() {
    const wrap = document.getElementById('keybinds');
    wrap.innerHTML = '';
    this.keyButtons = new Map();
    for (const [action, label] of BINDABLE) {
      const row = document.createElement('div');
      row.className = 'bindrow';
      const name = document.createElement('span');
      name.textContent = label;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bindkey';
      btn.addEventListener('click', () => this._capture(action, btn));
      row.append(name, btn);
      wrap.appendChild(row);
      this.keyButtons.set(action, btn);
    }
    document.getElementById('resetbinds').addEventListener('click', () => {
      this.onResetBinds?.();
      this.showBinds();
    });
    // The capture listener sits on the window in the capture phase so it beats
    // the game's own key handling: while a row is armed, the next key is a
    // binding and nothing else.
    addEventListener('keydown', e => {
      if (!this._capturing) return;
      e.preventDefault();
      e.stopPropagation();
      const action = this._capturing;
      this._capturing = null;
      if (e.code !== 'Escape') this.onBind?.(action, e.code);
      this.showBinds();
    }, true);
  }

  _capture(action, btn) {
    this._capturing = action;
    this.showBinds();
    btn.classList.add('arming');
    btn.textContent = 'press a key…';
  }

  /** Paint every key row from whatever the input layer is actually using. */
  showBinds() {
    if (!this.keyButtons) return;
    for (const [action, btn] of this.keyButtons) {
      btn.classList.toggle('arming', this._capturing === action);
      if (this._capturing === action) { btn.textContent = 'press a key…'; continue; }
      const keys = this.keysFor?.(action) ?? [];
      btn.textContent = keys.length ? keys.map(keyLabel).join(' / ') : '—';
      btn.classList.toggle('unbound', keys.length === 0);
    }
  }

  _load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }

  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  _entry(name) {
    if (!this.data[name]) {
      // seed from wherever the CSS grid currently puts it, so nothing jumps
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
      // clamp back on-screen: a button dragged off a big screen must still be
      // reachable on a small one
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

  /** Paint the mode rows from whatever the input layer currently thinks. */
  showModes() {
    for (const el of this.modeButtons) {
      const on = this.isToggle?.(el.dataset.action) ?? false;
      el.classList.toggle('on', (el.dataset.mode === 'toggle') === on);
    }
  }

  select(name) {
    this.selected = name;
    document.body.classList.add('has-selection');
    // the row for this button, if it is one of the two that can be toggled
    for (const row of document.querySelectorAll('.moderow')) {
      row.classList.toggle('active', row.dataset.action === name);
    }
    this.showModes();
    for (const el of this.buttons) el.classList.toggle('selected', el.dataset.btn === name);
    const d = this._entry(name);
    this.slider.disabled = false;
    this.slider.value = Math.round(d.s * 100);
    this.sizeval.textContent = Math.round(d.s * 100) + '%';
    this.onSelect?.(name);
  }

  enter() {
    this.editing = true;
    this._capturing = null;
    this.showModes();
    this.showBinds();
    document.body.classList.add('editing');
    this.panel.classList.remove('hidden');
    this.slider.disabled = true;
    this.sizeval.textContent = '--';
    this.selected = null;
    document.body.classList.remove('has-selection');
    for (const row of document.querySelectorAll('.moderow')) row.classList.remove('active');
    for (const el of this.buttons) el.classList.remove('selected');
  }

  exit() {
    this.editing = false;
    this._capturing = null;
    this._drag = null;
    document.body.classList.remove('editing');
    document.body.classList.remove('has-selection');
    this.panel.classList.add('hidden');
    for (const el of this.buttons) el.classList.remove('selected');
    this._save();
  }

  reset() {
    this.data = {};
    this.selected = null;
    document.body.classList.remove('has-selection');
    this.slider.disabled = true;
    this.sizeval.textContent = '--';
    for (const el of this.buttons) el.classList.remove('selected');
    this.apply();
    this._save();
  }
}

/** `KeyW` and `ShiftLeft` are not what anyone calls those keys. */
export function keyLabel(code) {
  if (!code) return '—';
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^Numpad(.+)$/.exec(code))) return 'Num ' + m[1];
  if ((m = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code))) {
    return (m[1] === 'Control' ? 'Ctrl' : m[1]) + ' ' + (m[2] === 'Left' ? 'L' : 'R');
  }
  return ({
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backquote: '`', Equal: '=',
    Minus: '-', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    CapsLock: 'Caps', Backspace: 'Bksp', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Backslash: '\\'
  })[code] || code;
}
