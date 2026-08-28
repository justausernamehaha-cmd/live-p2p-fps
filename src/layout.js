import { clamp } from './util.js';

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

    // hold-or-toggle, for the two actions where it makes sense to hold
    this.modeButtons = [...document.querySelectorAll('.modes button')];
    for (const el of this.modeButtons) {
      el.addEventListener('click', () => {
        this.onMode?.(el.dataset.action, el.dataset.mode === 'toggle');
        this.showModes();
      });
    }

    for (const el of this.buttons) this._bindDrag(el);
    this.apply();
    addEventListener('resize', () => this.apply());
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
    this.showModes();
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
