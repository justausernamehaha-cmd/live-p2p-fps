const $ = id => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), touch: $('touch'), menu: $('menu'), loading: $('loading'),
      health: $('healthfill'), healthnum: $('healthnum'),
      mag: $('mag'), reserve: $('reserve'), weaponname: $('weaponname'), reloading: $('reloading'),
      killfeed: $('killfeed'), hitmarker: $('hitmarker'), damage: $('damage'),
      crosshair: $('crosshair'), respawn: $('respawn'), respawnnum: $('respawnnum'),
      scoreboard: $('scoreboard'), scorebody: $('scorebody'),
      peercount: $('peercount'), ping: $('ping'), roomtag: $('roomtag'),
      chatform: $('chatform'), chatinput: $('chatinput'), status: $('status'),
      protection: $('protection')
    };
    this._cache = {};
    this._hitTimer = 0;
    this._dmgTimer = 0;
    this.chatOpen = false;
  }

  showGame(showTouch) {
    this.el.menu.classList.add('hidden');
    this.el.hud.classList.remove('hidden');
    this.el.touch.classList.toggle('hidden', !showTouch);
    document.body.classList.toggle('touch-ui', !!showTouch);
  }

  showMenu() {
    this.el.menu.classList.remove('hidden');
  }

  hideLoading() { this.el.loading.classList.add('hidden'); }

  status(text, isError = false) {
    this.el.status.textContent = text;
    this.el.status.classList.toggle('err', isError);
  }

  // These run every frame, so nothing is written unless it actually changed —
  // pointless DOM writes are a real cost on a phone.
  _set(key, value, apply) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    apply(value);
  }

  setNet(peers, ping, room) {
    this._set('peers', peers + 1, v => { this.el.peercount.textContent = v; });
    this._set('ping', ping ? Math.round(ping) : '--', v => { this.el.ping.textContent = v; });
    this._set('room', room, v => { this.el.roomtag.textContent = v; });
  }

  setHealth(hp) {
    this._set('hp', Math.max(0, Math.round(hp)), v => {
      this.el.health.style.width = v + '%';
      this.el.healthnum.textContent = v;
    });
  }

  setAmmo(name, mag, reserve, reloading) {
    this._set('wname', name, v => { this.el.weaponname.textContent = v; });
    this._set('mag', mag, v => { this.el.mag.textContent = v; });
    this._set('reserve', reserve, v => { this.el.reserve.textContent = v; });
    this._set('reloading', !!reloading, v => this.el.reloading.classList.toggle('hidden', !v));
  }

  hitmarker(kill) {
    const m = this.el.hitmarker;
    m.classList.toggle('kill', !!kill);
    m.classList.add('on');
    this._hitTimer = kill ? 0.35 : 0.15;
  }

  damageFlash() {
    this.el.damage.classList.add('on');
    this._dmgTimer = 0.12;
  }

  update(dt) {
    if (this._hitTimer > 0) {
      this._hitTimer -= dt;
      if (this._hitTimer <= 0) this.el.hitmarker.classList.remove('on');
    }
    if (this._dmgTimer > 0) {
      this._dmgTimer -= dt;
      if (this._dmgTimer <= 0) this.el.damage.classList.remove('on');
    }
  }

  ads(on) { this._set('ads', !!on, v => this.el.crosshair.classList.toggle('ads', v)); }

  /** Local-only readout: nobody else can see that you are shielded. */
  protection(text, locked) {
    this._set('prot', text, v => {
      this.el.protection.classList.toggle('hidden', !v);
      this.el.protection.textContent = v || '';
    });
    this._set('protlock', !!locked, v => this.el.protection.classList.toggle('locked', v));
  }

  feed(html, cls = '') {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = html;
    this.el.killfeed.appendChild(d);
    while (this.el.killfeed.childElementCount > 6) this.el.killfeed.firstChild.remove();
    setTimeout(() => d.remove(), 8000);
  }

  respawn(seconds) {
    if (seconds === null) { this.el.respawn.classList.add('hidden'); return; }
    this.el.respawn.classList.remove('hidden');
    this.el.respawnnum.textContent = Math.ceil(seconds);
  }

  scoreboard(rows, visible) {
    this.el.scoreboard.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.el.scorebody.innerHTML = rows
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .map(r => `<tr class="${r.me ? 'me' : ''}">
        <td><span class="dot" style="background:${r.color}"></span>${escapeHtml(r.name)}</td>
        <td>${r.kills}</td><td>${r.deaths}</td><td>${r.ping || '--'}</td></tr>`)
      .join('');
  }

  openChat() {
    this.chatOpen = true;
    this.el.chatform.classList.remove('hidden');
    this.el.chatinput.value = '';
    this.el.chatinput.focus();
  }

  closeChat() {
    this.chatOpen = false;
    this.el.chatform.classList.add('hidden');
    this.el.chatinput.blur();
  }

  bindChat(onSubmit, onClose) {
    this.el.chatform.addEventListener('submit', e => {
      e.preventDefault();
      const text = this.el.chatinput.value.trim();
      this.closeChat();
      if (text) onSubmit(text);
      onClose();
    });
    this.el.chatinput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { this.closeChat(); onClose(); }
    });
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
