import * as THREE from 'three';
import { World } from './world.js';
import { Player } from './player.js';
import { Input, isTyping } from './input.js';
import { Loadout, WEAPONS, HEADSHOT_MULT } from './weapons.js';
import { Effects, ViewModel } from './effects.js';
import { RemotePlayer } from './remote.js';
import { Hud, escapeHtml } from './hud.js';
import { Audio } from './audio.js';
import { Net, initNet, getSelfId } from './net.js';
import { clamp, colorFor, randomRoom, now, num } from './util.js';

const STATE_HZ = 20;
const RESPAWN_TIME = 3;
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
                  (navigator.maxTouchPoints > 1 && !matchMedia('(pointer:fine)').matches);

// stand-in used while input is suspended
const IDLE_INPUT = {
  moveVector: () => ({ x: 0, y: 0 }),
  consumeLook: () => ({ dx: 0, dy: 0 }),
  down: () => false,
  pressed: () => false,
  endFrame() {}
};

class Game {
  constructor() {
    this.hud = new Hud();
    this.audio = new Audio();
    this.remotes = new Map();
    this.net = null;
    this.name = localStorage.getItem('pa.name') || '';
    this.running = false;
    this.scoreVisible = false;
    this.lastStateSent = 0;
    this.deathAt = 0;

    this._initThree();
    this._initInput();
    this._initMenu();
    this.hud.hideLoading();
    window.__paStarted = true;
    window.game = this;          // handy in the console; also what the test harness pokes at
    requestAnimationFrame(t => this._frame(t));
  }

  // ------------------------------------------------------------------ setup
  _initThree() {
    const canvas = document.getElementById('game');
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: !IS_MOBILE, powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2));
    this.renderer.setSize(innerWidth, innerHeight, false);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b2433);
    this.scene.fog = new THREE.Fog(0x1b2433, 60, 150);

    this.camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.05, 400);
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xc8ddf5, 0x38414f, 1.9));
    const sun = new THREE.DirectionalLight(0xfff2de, 1.5);
    sun.position.set(30, 60, 18);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x86b4de, 0.5);
    fill.position.set(-25, 20, -30);
    this.scene.add(fill);

    this.world = new World(this.scene);
    this.player = new Player(this.world);
    this.player.spawn(this.world.randomSpawn());
    this.loadout = new Loadout();
    this.effects = new Effects(this.scene, this.camera);
    this.viewmodel = new ViewModel(this.camera);

    addEventListener('resize', () => this._resize());
    this._resize();
  }

  _resize() {
    const aspect = innerWidth / innerHeight;
    this.camera.aspect = aspect;
    // A fixed vertical FOV leaves a portrait phone with a ~40° horizontal view,
    // which is unplayable. Widen vertically to claw some of it back (landscape
    // is still much better, and the HUD says so once).
    this.camera.fov = aspect >= 1
      ? 78
      : clamp(2 * Math.atan(Math.tan(35 * Math.PI / 180) / aspect) * 180 / Math.PI, 78, 106);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight, false);
  }

  _initInput() {
    this.input = new Input(this.canvas);
    this.input.onKeyboardDetected = () => {
      // a physical keyboard showed up (common on tablets and phones with a
      // Bluetooth keyboard): retire the thumbstick, keep the touch look pad
      document.getElementById('stick').classList.remove('on');
    };
    this.input.onAction = a => {
      if (a === 'pause') { if (this.running && !this.hud.chatOpen) this._pause(); }
      else if (a === 'chat') this._openChat();
      else if (a === 'score') this.scoreVisible = true;
      else if (a === 'scoreoff') this.scoreVisible = false;
      else if (a === 'weapon') this._switch(this.loadout.cycle(1, now() / 1000));
      else if (a === 'menu') this._pause();
    };

    this.hud.bindChat(
      text => this._say(text),
      () => { this.input.setTextMode(false); this._relock(); }
    );

    addEventListener('keydown', e => {
      if (this.hud.chatOpen || !this.running || this.menuOpen || isTyping(e)) return;
      if (e.code === 'KeyT' || e.code === 'Enter') { e.preventDefault(); this._openChat(); }
    });
  }

  _initMenu() {
    const nameInput = document.getElementById('nameinput');
    const roomInput = document.getElementById('roominput');
    const playBtn = document.getElementById('playbtn');
    const shareBtn = document.getElementById('sharebtn');

    nameInput.value = this.name;
    const hashRoom = new URLSearchParams(location.hash.slice(1)).get('room');
    roomInput.value = hashRoom || localStorage.getItem('pa.room') || randomRoom();

    document.getElementById('randomroom').onclick = () => { roomInput.value = randomRoom(); };

    playBtn.onclick = () => {
      this.audio.resume();
      if (this.net) return this._resume();
      const name = (nameInput.value.trim() || 'player').slice(0, 14);
      const room = (roomInput.value.trim() || randomRoom()).toLowerCase().replace(/\s+/g, '-');
      localStorage.setItem('pa.name', name);
      localStorage.setItem('pa.room', room);
      playBtn.disabled = true;
      this._connect(name, room).then(ok => {
        playBtn.disabled = false;
        if (!ok) return;
        playBtn.textContent = 'RESUME';
        shareBtn.classList.remove('hidden');
      });
    };

    shareBtn.onclick = async () => {
      const url = location.origin + location.pathname + '#room=' + encodeURIComponent(this.room);
      try {
        if (navigator.share && IS_MOBILE) await navigator.share({ title: 'Peer Arena', url });
        else { await navigator.clipboard.writeText(url); this.hud.status('invite link copied'); }
      } catch { this.hud.status(url); }
    };
  }

  // ---------------------------------------------------------------- network
  async _connect(name, room) {
    this.name = name;
    this.room = room;
    const params = new URLSearchParams(location.hash.slice(1));
    const strategy = params.get('strategy') || 'nostr';
    location.hash = 'room=' + encodeURIComponent(room) +
      (strategy !== 'nostr' ? '&strategy=' + strategy : '');
    this.hud.status('connecting…');

    try {
      await initNet(strategy);
      this.net = new Net(room, { name }, {
        onJoin: id => this._peerJoin(id),
        onLeave: id => this._peerLeave(id),
        onHello: (id, m) => this._remote(id).setName(String(m.name || '').slice(0, 14)),
        onState: (id, s) => this._remote(id).onState(s),
        onShot: (id, m) => this._remoteShot(id, m),
        onHit: (id, m) => this._takeHit(id, m),
        onDied: (id, m) => this._someoneDied(id, m),
        onChat: (id, m) => this._chatIn(id, m),
        onPing: (id, rtt) => { const r = this.remotes.get(id); if (r) r.ping = rtt; },
        onJoinError: e => this.hud.feed('signalling error: ' + escapeHtml(e.error || ''), 'chat')
      });
    } catch (err) {
      console.error(err);
      this.hud.status('could not reach the signalling relays — try ' +
        'adding &strategy=torrent to the address: ' + err.message, true);
      return false;
    }

    this.player.spawn(this.world.randomSpawn());
    this.loadout.refill();
    this.running = true;
    this.menuOpen = false;
    this.hud.showGame(this.input.hasTouch);
    this.hud.status('');
    this.hud.feed(`room <b>${escapeHtml(room)}</b> — anyone opening the same room joins this match`, 'chat');
    // pointer lock cannot be requested here: the await above ended the user
    // gesture, so the first click on the canvas grabs the mouse instead
    if (!this.input.hasTouch) this.hud.feed('click the window to aim', 'chat');
    else if (innerHeight > innerWidth) this.hud.feed('turn the phone sideways for a much wider view', 'chat');
    return true;
  }

  _peerJoin(id) {
    this._remote(id);
    this.audio.join();
    this.hud.feed('a player connected', 'chat');
  }

  _peerLeave(id) {
    const r = this.remotes.get(id);
    if (r) { this.hud.feed(`<b>${escapeHtml(r.name)}</b> left`, 'chat'); r.dispose(); }
    this.remotes.delete(id);
  }

  _remote(id) {
    let r = this.remotes.get(id);
    if (!r) { r = new RemotePlayer(id, this.scene); this.remotes.set(id, r); }
    return r;
  }

  _remoteShot(id, m) {
    const from = { x: num(m.x), y: num(m.y), z: num(m.z) };
    const to = { x: num(m.tx), y: num(m.ty), z: num(m.tz) };
    const w = WEAPONS[m.w] || WEAPONS[0];
    this.effects.tracer(from, to, w.color);
    this.effects.impact(to, { x: 0, y: 0, z: 0 });
    const d = Math.hypot(from.x - this.player.pos.x, from.y - this.player.pos.y, from.z - this.player.pos.z);
    this.audio.shot(m.w, d);
  }

  _takeHit(fromId, m) {
    if (!this.player.alive) return;
    const died = this.player.damage(clamp(num(m.dmg), 0, 200));
    this.hud.damageFlash();
    this.audio.hurt();
    this.hud.setHealth(this.player.hp);
    if (died) {
      this.audio.death();
      this.deathAt = now();
      this.net.died(fromId);
      const killer = this.remotes.get(fromId);
      this.hud.feed(`<b>${escapeHtml(killer ? killer.name : 'someone')}</b> ▸ you`);
    }
  }

  _someoneDied(victimId, m) {
    const victim = this.remotes.get(victimId);
    const killerName = m.by === getSelfId() ? this.name : (this.remotes.get(m.by)?.name || 'someone');
    if (m.by === getSelfId()) {
      this.player.kills++;
      this.audio.kill();
      this.hud.hitmarker(true);
    } else if (this.remotes.has(m.by)) {
      this.remotes.get(m.by).kills++;
    }
    if (victim) { victim.alive = false; victim.deaths++; }
    this.hud.feed(`<b>${escapeHtml(killerName)}</b> ▸ ${escapeHtml(victim ? victim.name : 'someone')}`);
  }

  _chatIn(id, m) {
    const r = this.remotes.get(id);
    this.hud.feed(`<b>${escapeHtml(r ? r.name : 'peer')}</b>: ${escapeHtml(m.t)}`, 'chat');
  }

  // ------------------------------------------------------------------- chat
  _openChat() {
    if (!this.running || this.menuOpen) return;
    this.input.setTextMode(true);
    this.hud.openChat();
    document.exitPointerLock?.();
  }

  _say(text) {
    this.net?.chat(text);
    this.hud.feed(`<b>${escapeHtml(this.name)}</b>: ${escapeHtml(text)}`, 'chat');
  }

  // ------------------------------------------------------------------ pause
  _pause() {
    if (this.hud.chatOpen) return;
    this.menuOpen = true;
    this.hud.showMenu();
  }

  _resume() {
    this.menuOpen = false;
    this.hud.showGame(this.input.hasTouch);
    this._relock();
  }

  _relock() {
    this.input.requestLock();
  }

  // ----------------------------------------------------------------- firing
  _switch(changed) {
    if (!changed) return;
    this.viewmodel.setWeapon(this.loadout.index);
  }

  _fire(t, input) {
    const p = this.player;
    if (!p.alive) return;
    const w = this.loadout.tryFire(t, input.down('fire'), input.pressed('fire'));
    if (!w) return;

    const eye = new THREE.Vector3(p.pos.x, p.eyeY + p.bob, p.pos.z);
    const base = this._aimDirection();
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const spread = w.spread + w.spreadMove * clamp(speed / 9, 0, 1) + (p.onGround ? 0 : w.spreadMove);

    // muzzle position for the tracer: roughly where the viewmodel barrel ends
    const right = new THREE.Vector3().crossVectors(base, new THREE.Vector3(0, 1, 0)).normalize();
    const muzzle = eye.clone().addScaledVector(right, 0.22).addScaledVector(base, 0.6).setY(eye.y - 0.15);

    const damageByPeer = new Map();
    let endPoint = null;

    for (let i = 0; i < w.pellets; i++) {
      const dir = base.clone();
      if (spread > 0) {
        dir.x += (Math.random() - 0.5) * spread * 2;
        dir.y += (Math.random() - 0.5) * spread * 2;
        dir.z += (Math.random() - 0.5) * spread * 2;
        dir.normalize();
      }
      const hit = this._raycast(eye, dir, w.range);
      const end = eye.clone().addScaledVector(dir, hit.dist);
      if (!endPoint) endPoint = end;

      if (hit.player) {
        const dmg = w.damage * (hit.head ? HEADSHOT_MULT : 1);
        const e = damageByPeer.get(hit.player.id) || { dmg: 0, head: false, r: hit.player };
        e.dmg += dmg;
        e.head = e.head || hit.head;
        damageByPeer.set(hit.player.id, e);
      } else if (hit.dist < w.range) {
        this.effects.impact(end, dir);
      }
      if (w.pellets > 1) this.effects.tracer(muzzle, end, w.color);
    }

    if (w.pellets === 1) this.effects.tracer(muzzle, endPoint, w.color);
    this.effects.muzzle(w.shakeScale);
    this.viewmodel.fire(w.shakeScale);
    this.audio.shot(w.id, 0);
    p.addRecoil(w.recoil, (Math.random() - 0.5) * w.recoilYaw * 2);
    this.net?.shot(muzzle, endPoint, w.id);

    let killed = false;
    for (const [id, e] of damageByPeer) {
      this.net?.hit(id, e.dmg, e.head);
      e.r.hit();
      // local prediction so the kill marker is instant; corrected by their next state
      e.r.hp -= e.dmg;
      if (e.r.hp <= 0) killed = true;
    }
    if (damageByPeer.size) {
      this.hud.hitmarker(killed);
      this.audio.hit();
    }
  }

  _aimDirection() {
    const p = this.player;
    const pitch = clamp(p.pitch + p.recoil, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    const yaw = p.yaw + p.recoilYaw;
    return new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    ).normalize();
  }

  _raycast(origin, dir, range) {
    let dist = this.world.raycast(origin, dir, range);
    let best = { dist, player: null, head: false };
    for (const r of this.remotes.values()) {
      const h = r.raycast(origin, dir, best.dist);
      if (h && h.dist < best.dist) best = { dist: h.dist, player: r, head: h.head };
    }
    return best;
  }

  // ------------------------------------------------------------------- loop
  _frame(tMs) {
    requestAnimationFrame(t => this._frame(t));
    const t = tMs / 1000;
    const dt = Math.min(0.05, this._last ? t - this._last : 0.016);
    this._last = t;

    // remote players are advanced first so their hitboxes match the pixels
    for (const r of this.remotes.values()) r.update(dt);

    if (this.running) this._tick(t, dt);

    this.effects.update(dt);
    this.hud.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  _tick(t, dt) {
    const p = this.player;
    // while the menu or chat box is up the world keeps simulating (this is an
    // online game — you are still standing there) but stops taking commands
    const active = !this.menuOpen && !this.hud.chatOpen;
    const input = active ? this.input : IDLE_INPUT;

    const look = input.consumeLook(dt);
    p.look(look.dx, look.dy);

    if (input.pressed('weapon1')) this._switch(this.loadout.switchTo(0, t));
    if (input.pressed('weapon2')) this._switch(this.loadout.switchTo(1, t));
    if (input.pressed('weapon3')) this._switch(this.loadout.switchTo(2, t));
    if (input.pressed('weaponnext')) this._switch(this.loadout.cycle(1, t));
    if (input.pressed('weaponprev')) this._switch(this.loadout.cycle(-1, t));
    if (input.pressed('lastweapon')) this._switch(this.loadout.swapLast(t));
    if (input.pressed('reload') && this.loadout.startReload(t)) this.audio.reload();

    p.update(dt, input);
    if (this.loadout.update(t)) this.audio.reload();
    this._fire(t, input);

    // respawn
    if (!p.alive) {
      const left = RESPAWN_TIME - (now() - this.deathAt) / 1000;
      this.hud.respawn(Math.max(0, left));
      if (left <= 0) {
        p.spawn(this.world.randomSpawn());
        this.loadout.refill();
        this.hud.respawn(null);
        this.hud.setHealth(100);
      }
    }

    this._camera(dt);
    this.viewmodel.update(dt, p, this.loadout.reloading);

    // outgoing state
    if (this.net && t - this.lastStateSent > 1 / STATE_HZ) {
      this.lastStateSent = t;
      this.net.broadcastState(p, this.loadout);
    }

    this._hudTick(dt, input);
    this.input.endFrame();
  }

  _camera(dt) {
    const p = this.player;
    const cam = this.camera;
    const shake = this.effects.shake;
    cam.position.set(
      p.pos.x + (Math.random() - 0.5) * shake * 0.1,
      p.eyeY + p.bob + (Math.random() - 0.5) * shake * 0.1,
      p.pos.z
    );
    cam.rotation.set(0, 0, 0);
    cam.rotateY(p.yaw + p.recoilYaw);
    cam.rotateX(p.pitch + p.recoil);
    if (!p.alive) cam.rotateZ(0.9);        // drop the view on death
  }

  _hudTick(dt, input) {
    const a = this.loadout.ammo, w = this.loadout.weapon;
    this.hud.setAmmo(w.name, a.mag, a.reserve, this.loadout.reloading);
    this.hud.setHealth(this.player.hp);
    const speed = Math.hypot(this.player.vel.x, this.player.vel.z);
    this.hud.spread(speed > 4 || !this.player.onGround);

    const show = input.down('score') || this.scoreVisible;
    if (show) {
      const rows = [{
        name: this.name, color: colorFor(getSelfId()), kills: this.player.kills,
        deaths: this.player.deaths, ping: 0, me: true
      }];
      for (const r of this.remotes.values()) {
        rows.push({ name: r.name, color: '#' + r.color.getHexString(), kills: r.kills, deaths: r.deaths, ping: r.ping });
      }
      this.hud.scoreboard(rows, true);
    } else {
      this.hud.scoreboard([], false);
    }

    if (this.net) {
      const pings = [...this.net.pings.values()];
      const avg = pings.length ? pings.reduce((s, v) => s + v, 0) / pings.length : 0;
      this.hud.setNet(this.remotes.size, avg, this.room);
    }
  }
}

new Game();
