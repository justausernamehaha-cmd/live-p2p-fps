import * as THREE from 'three';
import { World } from './world.js';
import { Player, AIR } from './player.js';
import { Input, isTyping } from './input.js';
import { Loadout, WEAPONS, HEADSHOT_MULT, spreadFor } from './weapons.js';
import { Effects, ViewModel } from './effects.js';
import { RemotePlayer } from './remote.js';
import { Hud, escapeHtml } from './hud.js';
import { Layout } from './layout.js';
import { Audio } from './audio.js';
import { Net, initNet, getSelfId } from './net.js';
import { clamp, randomRoom, now, num, PLAYER_COLORS, colorIndexFor, cssColor } from './util.js';

const STATE_HZ = 20;
const RESPAWN_TIME = 3;
const EDIT_SHIELD_TAIL = 3000;   // ms of protection carried out of the layout editor
const EDIT_FIRE_LOCK = 5000;     // ms before the gun works again after editing
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
    this.editing = false;
    this.shieldUntil = 0;      // ms timestamps; while shielded, incoming damage is ignored
    this.fireLockUntil = 0;

    this._initThree();
    this._initInput();
    this._initMenu();
    // fetch the signalling module now rather than when CONNECT is pressed
    initNet(this.strategy).catch(() => { /* reported properly on connect */ });
    this.hud.hideLoading();
    window.__paStarted = true;
    window.game = this;          // handy in the console; also what the test harness pokes at
    window.__spreadFor = spreadFor;
    window.__air = AIR;          // movement tuning knobs, swept by test/mechanics.mjs
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

    // A second scene drawn after a depth clear: whatever is in here is always on
    // top of the world, which is how the gun stays whole when pressed into a wall.
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.01, 20);
    this.vmScene.add(new THREE.HemisphereLight(0xd6e6fa, 0x3a4459, 2.2));
    const vmKey = new THREE.DirectionalLight(0xfff4e2, 1.7);
    vmKey.position.set(1.2, 2.4, 1.6);
    this.vmScene.add(vmKey);

    this.world = new World(this.scene);
    this.player = new Player(this.world);
    this.player.spawn(this.world.randomSpawn());
    this.loadout = new Loadout();
    this.effects = new Effects(this.scene, this.camera, this.vmScene);
    this.viewmodel = new ViewModel(this.vmScene);

    addEventListener('resize', () => this._resize());
    addEventListener('orientationchange', () => setTimeout(() => this._resize(), 120));
    visualViewport?.addEventListener('resize', () => this._resize());
    this._resize();
  }

  _resize() {
    // visualViewport is the only measurement that excludes a phone's collapsing
    // URL bar; innerHeight can be taller than what you can actually see
    const w = Math.round(visualViewport?.width || innerWidth);
    const h = Math.round(visualViewport?.height || innerHeight);
    document.documentElement.style.setProperty('--appvh', h + 'px');
    const aspect = w / h;
    this.camera.aspect = aspect;
    // A fixed vertical FOV leaves a portrait phone with a ~40° horizontal view,
    // which is unplayable. Widen vertically to claw some of it back (landscape
    // is still much better, and the HUD says so once).
    this.baseFov = aspect >= 1
      ? 78
      : clamp(2 * Math.atan(Math.tan(35 * Math.PI / 180) / aspect) * 180 / Math.PI, 78, 106);
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = aspect;
    this.vmCamera.fov = this.baseFov;
    this.vmCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _initInput() {
    this.input = new Input(this.canvas);
    document.body.classList.toggle('has-touch', this.input.hasTouch);
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
      else if (a === 'layout') this._startEdit();
    };

    this.layout = new Layout();
    document.getElementById('donelayout').addEventListener('click', () => this._endEdit());

    // sensitivity lives in the same panel: LAYOUT opens it on a phone, backtick
    // opens it on a keyboard
    const sens = document.getElementById('sensslider');
    const sensVal = document.getElementById('sensval');
    const showSens = () => { sensVal.textContent = (this.input.sensitivity).toFixed(2) + '\u00d7'; };
    sens.value = Math.round(this.input.sensitivity * 100);
    showSens();
    sens.addEventListener('input', () => {
      this.input.setSensitivity(Number(sens.value) / 100);
      showSens();
    });

    // F3 shows exactly what the input layer thinks is happening, so a report of
    // "it did something strange" can be answered with numbers
    addEventListener('keydown', e => {
      if (e.code === 'F3') { e.preventDefault(); this.showDebug = !this.showDebug; }
    });

    addEventListener('keydown', e => {
      if (e.code !== 'Backquote' || isTyping(e) || this.hud.chatOpen) return;
      e.preventDefault();
      if (this.editing) this._endEdit();
      else this._startEdit();
    });

    const fsbtn = document.getElementById('fsbtn');
    fsbtn.addEventListener('click', () => this._toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      fsbtn.innerHTML = document.fullscreenElement ? '&#10005;' : '&#9974;';
    });

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

    this.strategy = new URLSearchParams(location.hash.slice(1)).get('strategy') || 'nostr';
    nameInput.value = this.name;
    const hashRoom = new URLSearchParams(location.hash.slice(1)).get('room');
    const knownRoom = hashRoom || localStorage.getItem('pa.room');
    roomInput.value = knownRoom || randomRoom();

    document.getElementById('randomroom').onclick = () => { roomInput.value = randomRoom(); };

    // Start finding peers while the player is still typing a name: by the time
    // they press CONNECT the handshake is usually already done, which is most of
    // the wait gone. Nothing is broadcast until they actually join the match.
    const prejoin = () => this._prejoin(this._roomFrom(roomInput.value));
    roomInput.addEventListener('change', prejoin);
    roomInput.addEventListener('blur', prejoin);
    if (knownRoom) setTimeout(prejoin, 50);   // an invite link or the last room played

    playBtn.onclick = () => {
      this.audio.resume();
      if (this.running) return this._resume();
      const name = (nameInput.value.trim() || 'player').slice(0, 14);
      const room = this._roomFrom(roomInput.value);
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
  _roomFrom(text) {
    return (String(text || '').trim() || randomRoom()).toLowerCase().replace(/\s+/g, '-');
  }

  /** Open the room early, without entering the match. */
  async _prejoin(room) {
    if (!room || this.running) return;
    if (this.net && this.net.roomCode === room) return;
    this.net?.leave();
    this.net = null;
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    try {
      await initNet(this.strategy);
      this.net = new Net(room, { name: this.name || 'player' }, this._netHandlers());
    } catch (err) {
      console.error(err);   // reported properly if they press CONNECT
    }
  }

  _netHandlers() {
    return {
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
    };
  }

  async _connect(name, room) {
    this.name = name;
    this.room = room;
    const strategy = this.strategy;
    location.hash = 'room=' + encodeURIComponent(room) +
      (strategy !== 'nostr' ? '&strategy=' + strategy : '');
    this.hud.status('connecting…');

    try {
      await initNet(strategy);
      if (!this.net || this.net.roomCode !== room) {
        this.net?.leave();
        this.net = new Net(room, { name }, this._netHandlers());
      } else {
        this.net.profile.name = name;    // already connected from the pre-join
        this.net.hello();
      }
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
    this._recolour();
  }

  _remote(id) {
    let r = this.remotes.get(id);
    if (!r) {
      r = new RemotePlayer(id, this.scene);
      this.remotes.set(id, r);
      this._recolour();
    }
    return r;
  }

  /** Everyone sorts the room the same way, so everyone agrees on who is which
   *  colour without anyone having to be in charge of handing them out. */
  _recolour() {
    const ids = [getSelfId(), ...this.remotes.keys()];
    this.myColor = PLAYER_COLORS[colorIndexFor(getSelfId(), ids)];
    for (const [id, r] of this.remotes) r.setColor(PLAYER_COLORS[colorIndexFor(id, ids)]);
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
    if (!this.running || !this.player.alive || this.shielded) return;
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

  // ---------------------------------------------------------- layout editing
  _startEdit() {
    if (this.editing || this.menuOpen || !this.running) return;
    this.editing = true;
    this.input.editMode = true;
    this.input.held.clear();
    const touch = document.body.classList.contains('touch-ui');
    document.getElementById('edittitle').textContent = touch ? 'Layout & settings' : 'Settings';
    document.getElementById('edithint').textContent = touch
      ? 'drag a button to move it \u00b7 tap one, then resize it \u00b7 ` also opens this'
      : 'press ` again, or DONE, to close';
    this.layout.enter();
    document.exitPointerLock?.();
  }

  _endEdit() {
    if (!this.editing) return;
    this.editing = false;
    this.input.editMode = false;
    this.layout.exit();
    // the shield does not vanish the instant the panel closes, but it does not
    // linger either: three seconds to get to cover, five before the gun works
    this.shieldUntil = now() + EDIT_SHIELD_TAIL;
    this.fireLockUntil = now() + EDIT_FIRE_LOCK;
    this._relock();
  }

  get shielded() { return this.editing || now() < this.shieldUntil; }

  async _toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      // the viewport changes size on the way in and out
      setTimeout(() => this._resize(), 150);
    } catch { /* refused, or unsupported on this browser */ }
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
    if (!p.alive || now() < this.fireLockUntil) return;
    const w = this.loadout.tryFire(t, input.down('fire'), input.pressed('fire'));
    if (!w) return;

    const eye = new THREE.Vector3(p.pos.x, p.eyeY + p.bob, p.pos.z);
    const base = this._aimDirection();
    const moving = Math.hypot(p.vel.x, p.vel.z) > 1.5 || !p.onGround;
    const spread = spreadFor(w, moving);

    // the tracer leaves the barrel tip of the gun actually on screen: read its
    // position out of the viewmodel scene (which is camera space) and put it
    // into the world with the camera's own transform
    this.camera.updateMatrixWorld(true);
    const muzzle = this.viewmodel.muzzleOffset(new THREE.Vector3())
      .applyMatrix4(this.camera.matrixWorld);

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

      if (hit.player && !hit.player.shielded) {
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

    const r = this.renderer;
    r.autoClear = false;
    r.clear();
    r.render(this.scene, this.camera);
    r.clearDepth();                       // the gun is drawn over everything
    r.render(this.vmScene, this.vmCamera);
  }

  _tick(t, dt) {
    const p = this.player;
    // while the menu or chat box is up the world keeps simulating (this is an
    // online game — you are still standing there) but stops taking commands
    const active = !this.menuOpen && !this.hud.chatOpen && !this.editing;
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

    // camera and viewmodel first: the shot is traced from where they actually
    // are this frame, not from where they were on the last one
    this._camera(dt);
    this.viewmodel.update(dt, p, this.loadout.reloading);
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

    // outgoing state
    if (this.net && t - this.lastStateSent > 1 / STATE_HZ) {
      this.lastStateSent = t;
      this.net.broadcastState(p, this.loadout, this.shielded);
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
    if (this.showDebug) {
      const i = this.input, p = this.player;
      this._dbgT = (this._dbgT || 0) + dt;
      if (this._dbgT > 0.15) {
        this._dbgT = 0;
        this.hud.debug([
          `held      ${[...i.held].sort().join(' ') || '-'}`,
          `keyLook   x=${i.keyLook.x} y=${i.keyLook.y}   <- non-zero here spins the view`,
          `stick     x=${i.stick.x.toFixed(2)} y=${i.stick.y.toFixed(2)}`,
          `mouse     locked=${i.pointerLocked} raw=${i.rawInput} drag=${!!i._mouseDrag}`,
          `locks     ${i.lockChanges} changes, dropped ${i.dropped} spikes`,
          `clamped   ${i.clamped} events, last ${i.lastClamp[0]},${i.lastClamp[1]} -> capped at 80px`,
          `look      dx=${i.lookDX.toFixed(3)} dy=${i.lookDY.toFixed(3)}`,
          `lastMove  ${i.lastMovement[0]}, ${i.lastMovement[1]}  (spikes are dropped)`,
          `yaw/pitch ${p.yaw.toFixed(2)} / ${p.pitch.toFixed(2)}`,
          `vel       ${Math.hypot(p.vel.x, p.vel.z).toFixed(2)} m/s  ground=${p.onGround}`,
          `fps       ${Math.round(1 / Math.max(dt, 0.001))}`
        ].join('\n'));
      }
    } else {
      this.hud.debug('');
    }

    // a mouse user with no pointer capture aims by dragging, which is worth
    // saying out loud rather than leaving them to wonder
    this.hud.lockHint(this.input.needsMouseCapture && !this.menuOpen && !this.editing && !this.hud.chatOpen);

    // shield and fire lock are only ever shown to the player they apply to
    const t = now();
    const shieldLeft = this.editing ? Infinity : (this.shieldUntil - t) / 1000;
    const lockLeft = (this.fireLockUntil - t) / 1000;
    if (this.editing) {
      this.hud.protection('shielded while editing', false);
    } else if (lockLeft > 0 || shieldLeft > 0) {
      const parts = [];
      if (shieldLeft > 0) parts.push(`shielded ${shieldLeft.toFixed(1)}s`);
      if (lockLeft > 0) parts.push(`weapon locked ${lockLeft.toFixed(1)}s`);
      this.hud.protection(parts.join('\n'), lockLeft > 0 && shieldLeft <= 0);
    } else {
      this.hud.protection('', false);
    }

    const a = this.loadout.ammo, w = this.loadout.weapon;
    this.hud.setAmmo(w.name, a.mag, a.reserve, this.loadout.reloading);
    this.hud.setHealth(this.player.hp);

    const show = input.down('score') || this.scoreVisible;
    if (show) {
      const rows = [{
        name: this.name, color: cssColor(this.myColor ?? PLAYER_COLORS[0]), kills: this.player.kills,
        deaths: this.player.deaths, ping: 0, me: true
      }];
      for (const r of this.remotes.values()) {
        rows.push({ name: r.name, color: cssColor(r.colorHex), kills: r.kills, deaths: r.deaths, ping: r.ping });
      }
      this.hud.scoreboard(rows, true);
    } else {
      this.hud.scoreboard([], false);
    }

    if (this.net) {
      const pings = [...this.net.pings.values()];
      const avg = pings.length ? pings.reduce((s, v) => s + v, 0) / pings.length : 0;
      const active = [...this.remotes.values()].filter(r => r.buffer.length > 0).length;
      this.hud.setNet(active, avg, this.room);
    }
  }
}

new Game();
