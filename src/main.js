import * as THREE from 'three';
import { World } from './world.js';
import { Player, AIR } from './player.js';
import { Input, isTyping } from './input.js';
import { Loadout, WEAPONS, HEADSHOT_MULT, spreadFor, ADS_ZOOM, ADS_TIME } from './weapons.js';
import { Effects, ViewModel } from './effects.js';
import { RemotePlayer, SelfAvatar } from './remote.js';
import { Hud, escapeHtml } from './hud.js';
import { Layout } from './layout.js';
import { Level, MIN_W, MAX_W, MIN_H, MAX_H } from './level.js';
import { Designer } from './designer.js';
import { Audio } from './audio.js';
import { PortalField } from './portalgun.js';
import { portalMap, HALF_W, HALF_H } from './portal.js';
import { lookFrom, anglesIn, basisFor, upFromIndex, UPS } from './frame.js';
import { Net, initNet, getSelfId } from './net.js';
import { ERASE_ANGLE, HOLE_TIME, STAMP_STEP } from './erase.js';
import { clamp, randomRoom, now, num, PLAYER_COLORS, colorIndexFor, cssColor } from './util.js';

const STATE_HZ = 20;
const RESPAWN_TIME = 3;
// One timer covers both the shield and the weapon lock.
const EDIT_PROTECTION = 3000;    // ms after closing the settings panel
const JOIN_PROTECTION = 3000;    // ms after joining a room already in play
// A room is found by listening: this long with nobody there and it is yours.
const SCAN_TIME = 2500;
const SEED_WAIT = 2500;          // ...and this long for its seed to arrive
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DESIGN_CODE = /^level[\s_-]*design(er)?$/i;
const CRUSHED_BY = '#platform';  // killer ids that are not players
const OUT_OF_BOUNDS = '#bounds';
const SHOT_PORTALS = 2;          // how many mouths one shot may pass
const BODY_RADIUS = 0.17;        // a peer's drawn body, for White Out hits
const WHITE_OUT_ID = WEAPONS.findIndex(w => w.erase);
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
                  (navigator.maxTouchPoints > 1 && !matchMedia('(pointer:fine)').matches);

// stand-in while input is suspended (menu, chat, settings)
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
    this.design = null;        // the level designer, while a design room is open
    this.protectedUntil = 0;   // ms: shielded and unable to fire until then
    this.adsT = 0;             // 0 hipfire, 1 fully aimed

    this._initThree();
    this._initInput();
    this._initMenu();
    initNet(this.strategy).catch(() => { /* reported properly on connect */ });
    this.hud.hideLoading();
    // test hooks
    window.__paStarted = true;
    window.game = this;
    window.__spreadFor = spreadFor;
    window.__WEAPONS = WEAPONS;
    window.__frame = { anglesIn, lookFrom, basisFor, UPS };
    window.__air = AIR;
    window.__selfId = getSelfId;
    window.__Level = Level;
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
    this.scene.fog = new THREE.Fog(0x1b2433, 150, 380);

    // Near plane at 15 mm: an eye standing in a mouth can be that close to the
    // wall beside the hole, and a farther near plane lets you see through it.
    this.camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.015, 400);
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xc8ddf5, 0x38414f, 1.9));
    const sun = new THREE.DirectionalLight(0xfff2de, 1.5);
    sun.position.set(30, 60, 18);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x86b4de, 0.5);
    fill.position.set(-25, 20, -30);
    this.scene.add(fill);

    // the gun: a second scene drawn after a depth clear, so it is always on top
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
    this.portals = new PortalField(this.scene, this.effects, this.world);
    this.portals.onPlaced = (side, p) => this.net?.portal(side, p);
    this.player.portals = this.portals;
    // your own body, seen only through portals
    this.selfAvatar = new SelfAvatar(this.scene);
    this.portals.selfView = this.selfAvatar.root;

    addEventListener('resize', () => this._resize());
    addEventListener('orientationchange', () => setTimeout(() => this._resize(), 120));
    visualViewport?.addEventListener('resize', () => this._resize());
    addEventListener('focusin', () => this._resize());
    addEventListener('focusout', () => setTimeout(() => this._resize(), 50));
    this._pinScroll();
    // the hint is the one HUD element that takes clicks: it captures the mouse
    document.getElementById('lockhint').addEventListener('pointerdown', e => {
      e.preventDefault();
      this.input.mouseSeen = true;
      this.input.requestLock(true);
    });
    this._resize();
  }

  /** The document never scrolls (focusing a field or a phone keyboard would slide
   *  the whole UI). Only the document is pinned; the menu scrolls inside itself. */
  _pinScroll() {
    const pin = () => {
      if (scrollX || scrollY) scrollTo(0, 0);
      for (const el of [document.documentElement, document.body]) {
        if (el.scrollTop) el.scrollTop = 0;
        if (el.scrollLeft) el.scrollLeft = 0;
      }
    };
    addEventListener('scroll', pin, { passive: true });
    document.addEventListener('scroll', pin, { capture: true, passive: true });
    pin();
  }

  _resize() {
    // visualViewport excludes a phone's collapsing URL bar
    const w = Math.round(visualViewport?.width || innerWidth);
    let h = Math.round(visualViewport?.height || innerHeight);
    // a virtual keyboard is not a smaller screen: keep the last height measured
    // without a text field focused
    if (isTyping({ target: document.activeElement })) h = this._viewH || h;
    else this._viewH = h;
    document.documentElement.style.setProperty('--appvh', h + 'px');
    const aspect = w / h;
    this.camera.aspect = aspect;
    // widen the vertical fov in portrait, or the horizontal view is ~40 degrees
    this.baseFov = aspect >= 1
      ? 78
      : clamp(2 * Math.atan(Math.tan(35 * Math.PI / 180) / aspect) * 180 / Math.PI, 78, 106);
    this.camera.fov = this.baseFov / (1 + (ADS_ZOOM - 1) * (this.adsT || 0));
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = aspect;
    this.vmCamera.fov = this.baseFov;   // the gun is not magnified by aiming
    this.vmCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _initInput() {
    this.input = new Input(this.canvas);
    document.body.classList.toggle('has-touch', this.input.hasTouch);
    // a physical keyboard retires the thumbstick
    this.input.onKeyboardDetected = () => document.getElementById('stick').classList.remove('on');
    this.input.onAction = a => {
      if (a === 'pause') {
        // losing the lock usually means Esc, but not when the designer's Alt, the
        // chat box or the settings panel released it on purpose
        if (this.design?.mouseFree) return;
        if (this.running && !this.hud.chatOpen && !this.editing) this._pause();
      }
      else if (a === 'chat') this._openChat();
      else if (a === 'score') this.scoreVisible = true;
      else if (a === 'scoreoff') this.scoreVisible = false;
      else if (a === 'weapon') this._switch(this.loadout.cycle(1, now() / 1000));
      else if (a === 'menu') this._pause();
      else if (a === 'settings') { if (this.editing) this._endEdit(); else this._startEdit(); }
      else if (a === 'layout') this._startEdit();
    };

    this.layout = new Layout();
    this.layout.isToggle = a => this.input.isToggle(a);
    this.layout.onMode = (action, toggle) => this.input.setToggleMode(action, toggle);
    this.layout.keysFor = (a, design) => this.input.keysFor(a, design);
    this.layout.onBind = (a, code, replacing, design) => this.input.bind(a, code, replacing, design);
    this.layout.onUnbind = (a, code, design) => this.input.unbind(a, code, design);
    this.layout.onResetBinds = design => this.input.resetBinds(design);
    this.layout.showModes();
    this.layout.showBinds();
    document.getElementById('donelayout').addEventListener('click', () => this._endEdit());

    const sens = document.getElementById('sensslider');
    const sensVal = document.getElementById('sensval');
    const showSens = () => { sensVal.textContent = (this.input.sensitivity).toFixed(2) + '×'; };
    sens.value = Math.round(this.input.sensitivity * 100);
    showSens();
    sens.addEventListener('input', () => {
      this.input.setSensitivity(Number(sens.value) / 100);
      showSens();
    });

    // Swallowing Ctrl+W needs fullscreen, so it is a checkbox, and its label says
    // what is actually true rather than what was asked for.
    const kblock = document.getElementById('kblock');
    const kblockVal = document.getElementById('kblockval');
    const showKblock = () => {
      kblockVal.textContent = !kblock.checked ? 'browser keeps them'
        : !navigator.keyboard?.lock ? 'this browser cannot'
        : this.input.shortcutsBlocked ? 'blocked'
        : 'click the game to arm';
    };
    kblock.checked = this.input.wantFullscreenLock;
    showKblock();
    kblock.addEventListener('change', () => {
      this.input.setFullscreenLock(kblock.checked);
      showKblock();
    });
    document.addEventListener('fullscreenchange', () => setTimeout(showKblock, 60));
    document.addEventListener('pointerlockchange', () => setTimeout(showKblock, 60));

    // F3: what the input layer thinks is happening
    addEventListener('keydown', e => {
      if (e.code === 'F3') { e.preventDefault(); this.showDebug = !this.showDebug; }
    });

    const fsbtn = document.getElementById('fsbtn');
    fsbtn.addEventListener('click', () => this._toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      fsbtn.innerHTML = document.fullscreenElement ? '&#10005;' : '&#9974;';
    });

    this.hud.bindChat(
      text => this._say(text),
      () => { this.input.setTextMode(false); this.input.requestLock(); }
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
    const hash = new URLSearchParams(location.hash.slice(1));

    this.strategy = hash.get('strategy') || 'nostr';
    nameInput.value = this.name;
    const knownRoom = hash.get('room') || localStorage.getItem('pa.room');
    roomInput.value = knownRoom || randomRoom();

    document.getElementById('randomroom').onclick = () => { roomInput.value = randomRoom(); };

    // a level seed arrives from an invite link or a paste
    const seedInput = document.getElementById('seedinput');
    seedInput.value = hash.get('seed') || localStorage.getItem('pa.seed') || '';
    if (seedInput.value) document.getElementById('seedwrap').open = true;
    this.seedInput = seedInput;

    // open the room while the name is still being typed: most of the wait is gone
    // by the time CONNECT is pressed
    const prejoin = () => this._prejoin(this._roomFrom(roomInput.value));
    roomInput.addEventListener('change', prejoin);
    roomInput.addEventListener('blur', prejoin);
    if (knownRoom) setTimeout(prejoin, 50);

    playBtn.onclick = () => {
      this.audio.resume();
      if (this.running) return this._resume();
      const name = (nameInput.value.trim() || 'player').slice(0, 14);
      localStorage.setItem('pa.name', name);
      this.name = name;

      if (DESIGN_CODE.test(roomInput.value.trim())) return this.openDesignSetup();

      const seed = seedInput.value.trim();
      if (seed) {
        // only to catch a broken paste now
        try { Level.decode(seed); }
        catch (err) { this.hud.status(err.message, true); return; }
      }
      const room = this._roomFrom(roomInput.value);
      localStorage.setItem('pa.room', room);
      try { localStorage.setItem('pa.seed', seed); } catch { /* private mode */ }
      playBtn.disabled = true;
      this._enterRoom(name, room, seed).then(ok => {
        playBtn.disabled = false;
        if (!ok) return;
        playBtn.textContent = 'RESUME';
        shareBtn.classList.remove('hidden');
        document.getElementById('exitbtn').classList.remove('hidden');
      });
    };

    document.getElementById('exitbtn').onclick = () => this.leaveRoom();

    // the way back into settings if its key has been unbound
    document.getElementById('menusettings').onclick = () => {
      if (!this.running) return;
      // not _resume(): that would ask for the pointer the panel needs
      this.menuOpen = false;
      document.getElementById('designsetup').classList.add('hidden');
      this.hud.showGame(this.input.hasTouch);
      this._startEdit();
    };

    shareBtn.onclick = async () => {
      const url = location.origin + location.pathname + '#room=' + encodeURIComponent(this.room) +
        (this.seed ? '&seed=' + encodeURIComponent(this.seed) : '');
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

  /** Leave any room and forget its players. */
  _dropNet() {
    this.net?.leave();
    this.net = null;
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
  }

  /** Open a room (initNet must have finished). */
  _openRoom(room) {
    this._dropNet();
    this.net = new Net(room, { name: this.name || 'player', pr: this.portals.myRandom },
                       this._netHandlers());
    this._roomOpenedAt = now();
  }

  _relayError(err) {
    console.error(err);
    this.hud.status('could not reach the signalling relays — try ' +
      'adding &strategy=torrent to the address: ' + err.message, true);
  }

  /** Open the room early, without entering the match. */
  async _prejoin(room) {
    if (!room || this.running || DESIGN_CODE.test(room)) return;
    if (this.net && this.net.roomCode === room) return;
    this._dropNet();
    try {
      await initNet(this.strategy);
      this._openRoom(room);
    } catch (err) {
      console.error(err);   // reported properly if they press CONNECT
    }
  }

  /** CONNECT. There is no server to ask whether a room exists, so it is listened
   *  for: empty means yours, with your seed; occupied means the room's own seed,
   *  and you arrive behind a three-second shield. */
  async _enterRoom(name, room, seed) {
    this.name = name;
    this.input.suspendLock = false;     // LEAVE THE ROOM parked it
    this.hud.status('');
    this.hud.joining('Looking for the room…', `room code ${room}`);
    let found = false;
    try {
      found = await this._scanRoom(room);
    } catch (err) {
      this.hud.joining(null);
      this._relayError(err);
      return false;
    }

    let level = null;
    this.joinedExisting = found;
    if (!found) {
      if (seed) {
        try { level = Level.decode(seed); }
        catch (err) { this.hud.joining(null); this.hud.status(err.message, true); return false; }
      }
      this.seed = seed;
    } else {
      this.hud.joining('Joining the room…', 'somebody is already playing this room, so its level is the one you get');
      const theirs = await this._askRoomSeed();
      this.seed = theirs || '';
      if (theirs) {
        try { level = Level.decode(theirs); }
        catch { level = null; this.seed = ''; }    // unreadable: the default arena
      }
    }
    this.world.setLevel(level);
    this.hud.joining(null);
    const ok = await this._connect(name, room);
    if (!ok) return false;
    if (found) {
      this.protectedUntil = now() + JOIN_PROTECTION;
      this.hud.feed('joined an existing room — shielded for three seconds', 'chat');
      if (seed && seed !== this.seed) {
        this.hud.feed('the room already had a level, so the seed you pasted was not used', 'chat');
      }
    }
    return true;
  }

  /** True if anybody else is in the room. The clock runs from when the room was
   *  opened (usually by the pre-join), not from when CONNECT was pressed. */
  async _scanRoom(room) {
    await initNet(this.strategy);
    if (!this.net || this.net.roomCode !== room) this._openRoom(room);
    const openedAt = this._roomOpenedAt || now();
    while (now() - openedAt < SCAN_TIME) {
      if (this.net.peerCount > 0) return true;
      await sleep(80);
    }
    return this.net.peerCount > 0;
  }

  /** The room's level seed: first answer wins, silence means the default arena. */
  async _askRoomSeed() {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; this._onSeed = null; resolve(v); } };
      this._onSeed = finish;
      this.net?.askSeed();
      setTimeout(() => finish(null), SEED_WAIT);
    });
  }

  leaveRoom() {
    this._dropNet();
    this._stroke = null;
    this.portals.clear();
    this.world.eraseClear();
    this.running = false;
    this.menuOpen = false;
    this.joinedExisting = false;
    this.protectedUntil = 0;
    this.hud.joining(null);
    this.hud.respawn(null);
    this.hud.status('left the room');
    document.getElementById('playbtn').textContent = 'CONNECT';
    document.getElementById('sharebtn').classList.add('hidden');
    document.getElementById('exitbtn').classList.add('hidden');
    this.hud.showMenu(false);
    document.getElementById('menu').classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('touch').classList.add('hidden');
    document.body.classList.remove('touch-ui', 'paused');
    document.exitPointerLock?.();
    this.input.suspendLock = true;      // the menu is to be clicked, not aimed with
    this.player.spawn(this.world.randomSpawn());
    this.loadout.refill();
  }

  _netHandlers() {
    return {
      onJoin: id => this._peerJoin(id),
      onLeave: id => this._peerLeave(id),
      onHello: (id, m) => {
        const r = this._remote(id);
        r.setName(String(m.name || '').slice(0, 14));
        r.portalRandom = num(m.pr, 0);
        this._recolour();
      },
      onState: (id, s) => this._remote(id).onState(s),
      onShot: (id, m) => this._remoteShot(id, m),
      onHit: (id, m) => this._takeHit(id, m),
      onDied: (id, m) => this._someoneDied(id, m),
      onChat: (id, m) => this._chatIn(id, m),
      onPortalBall: (id, m) => this.portals.fire(
        id, { x: num(m.x), y: num(m.y), z: num(m.z) },
        { x: num(m.dx), y: num(m.dy), z: num(m.dz) }, m.s === 'b' ? 'b' : 'a', true,
        upFromIndex(num(m.u, 2))),
      onPortal: (id, m) => this._remotePortal(id, m),
      onErasePaint: (id, m) => this._remotePaint(id, m),
      onEraseOpen: (id, m) => this._remoteOpen(id, m),
      onPing: (id, rtt) => { const r = this.remotes.get(id); if (r) r.ping = rtt; },
      onSeedAsk: id => this.net?.tellSeed(id, this.seed || ''),
      onSeedTell: (id, m) => this._onSeed?.(typeof m?.sd === 'string' ? m.sd : ''),
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
        this._openRoom(room);
      } else {
        this.net.profile.name = name;    // already open from the pre-join
        this.net.hello();
      }
    } catch (err) {
      this._relayError(err);
      return false;
    }

    this.player.spawn(this.world.randomSpawn());
    this.loadout.refill();
    this.running = true;
    this.menuOpen = false;
    this.hud.showGame(this.input.hasTouch);
    this.hud.status('');
    this.hud.feed(`room <b>${escapeHtml(room)}</b> — anyone opening the same room joins this match`, 'chat');
    // the await ended the user gesture, so the first click captures the mouse
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
    this.portals.forget(id);          // nobody could ever replace their portals
    this.world.eraseForget(id);       // ...or finish their White Out stroke
    this._recolour();
  }

  _remote(id) {
    let r = this.remotes.get(id);
    if (!r) {
      r = new RemotePlayer(id, this.scene);
      r.portals = this.portals;
      this.remotes.set(id, r);
      this._recolour();
    }
    return r;
  }

  /** Everyone sorts the room the same way, so colours agree with no authority.
   *  Portal colours also fold in each player's announced random number. */
  _recolour() {
    const ids = [getSelfId(), ...this.remotes.keys()];
    this.myColor = PLAYER_COLORS[colorIndexFor(getSelfId(), ids)];
    for (const [id, r] of this.remotes) r.setColor(PLAYER_COLORS[colorIndexFor(id, ids)]);

    this.portals.setSelfId(getSelfId());
    this.portals.recolour([
      { id: this.portals.selfId, r: this.portals.myRandom },
      ...[...this.remotes].map(([id, r]) => ({ id, r: r.portalRandom || 0 }))
    ]);
    this._paintGun();
  }

  _remotePortal(id, m) {
    const v = (a, b, c) => ({ x: num(m[a]), y: num(m[b]), z: num(m[c]) });
    const n = v('nx', 'ny', 'nz');
    if (!Math.hypot(n.x, n.y, n.z)) return;      // nonsense
    this.portals.place(id, m.s === 'b' ? 'b' : 'a', {
      c: v('x', 'y', 'z'), n, u: v('ux', 'uy', 'uz'), v: v('vx', 'vy', 'vz'),
      mover: num(m.m, -1)
    });
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
      this.net.died(fromId, m.er ? 'er' : '');
      const killer = this.remotes.get(fromId);
      this.hud.feed(`<b>${escapeHtml(killer ? killer.name : 'someone')}</b> ${m.er ? 'erased' : '▸'} ` +
                    `<b>${escapeHtml(this.name)}</b>`);
    }
  }

  _someoneDied(victimId, m) {
    const victim = this.remotes.get(victimId);
    const killerName = m.by === CRUSHED_BY ? 'platform'
      : m.by === OUT_OF_BOUNDS ? 'out of bounds'
      : m.by === getSelfId() ? this.name
      : (this.remotes.get(m.by)?.name || 'someone');
    if (m.by === getSelfId()) {
      this.player.kills++;
      this.audio.kill();
      this.hud.hitmarker(true);
      const gained = this.loadout.awardOnKill();
      if (gained) this.hud.feed(`+${gained} ${escapeHtml(this.loadout.weapon.name.toLowerCase())} ammo`, 'chat');
    } else if (this.remotes.has(m.by)) {
      this.remotes.get(m.by).kills++;
    }
    if (victim) { victim.alive = false; victim.deaths++; }
    this.hud.feed(`<b>${escapeHtml(killerName)}</b> ${m.how === 'er' ? 'erased' : '▸'} ` +
                  escapeHtml(victim ? victim.name : 'someone'));
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

  // ------------------------------------------------------------ level design
  /** The room-size chooser; also the way out of an open level. */
  openDesignSetup() {
    const panel = document.getElementById('designsetup');
    const saved = Designer.savedSeed();
    const resume = document.getElementById('dresume');
    resume.classList.toggle('hidden', !saved);
    document.getElementById('dsetupmsg').textContent = '';
    this.hud.showMenu(false);
    document.getElementById('menu').classList.add('hidden');
    panel.classList.remove('hidden');

    if (this._designSetupBound) return;
    this._designSetupBound = true;

    const field = (id, lo, hi, fallback) => {
      const v = Number(document.getElementById(id).value);
      return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
    };
    document.getElementById('dstart').onclick = () => {
      this._enterDesign(new Level(field('dw', MIN_W, MAX_W, 60),
                                 field('dl', MIN_W, MAX_W, 60),
                                 field('dh', MIN_H, MAX_H, 14)));
    };
    resume.onclick = () => {
      try {
        this._enterDesign(Level.decode(Designer.savedSeed()));
      } catch (err) {
        document.getElementById('dsetupmsg').textContent = err.message;
      }
    };
    document.getElementById('dcancel').onclick = () => {
      panel.classList.add('hidden');
      if (this.design) this.hud.showGame(this.input.hasTouch);
      else this.hud.showMenu(false);
    };
  }

  _enterDesign(level) {
    document.getElementById('designsetup').classList.add('hidden');
    this._dropNet();                // single-player: nobody may wander in
    this._stroke = null;
    this.room = 'level design';
    this.seed = '';
    this.portals.clear();
    this.running = true;
    this.menuOpen = false;
    this.design = this.design || new Designer(this);
    this.design.start(level);
    this.hud.showGame(this.input.hasTouch);
    this.hud.status('');
    document.getElementById('playbtn').textContent = 'RESUME';
    if (!this.input.hasTouch) this.hud.feed('click the window to aim', 'chat');
  }

  leaveDesign() {
    if (!this.design) return;
    this.design.stop();
    this.design = null;
    this._stroke = null;
    this.portals.clear();
    this.running = false;
    this.world.setLevel(null);
    this.player.spawn(this.world.randomSpawn());
    document.getElementById('playbtn').textContent = 'CONNECT';
    this.hud.showMenu(false);
    document.exitPointerLock?.();
  }

  // ---------------------------------------------------------- layout editing
  _startEdit() {
    if (this.editing || this.menuOpen || !this.running) return;
    this.editing = true;
    this.input.editMode = true;
    this.input.suspendLock = true;      // the panel is there to be clicked
    this.input.held.clear();
    const touch = document.body.classList.contains('touch-ui');
    document.getElementById('edittitle').textContent = touch ? 'Layout & settings' : 'Settings';
    document.getElementById('edithint').textContent = touch
      ? 'drag a button to move it · tap one, then resize it · ` also opens this'
      : 'press ` again, or DONE, to close';
    this.layout.enter();
    document.exitPointerLock?.();
  }

  _endEdit() {
    if (!this.editing) return;
    this.editing = false;
    this.input.editMode = false;
    this.input.suspendLock = false;
    this.layout.exit();
    // shielded and unable to fire for three seconds more, so nobody edits their
    // way into a free shot
    this.protectedUntil = now() + EDIT_PROTECTION;
    this.input.requestLock();
  }

  /** Incoming damage is ignored, and the gun will not fire. */
  get shielded() { return this.editing || now() < this.protectedUntil; }

  async _toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      setTimeout(() => this._resize(), 150);
    } catch { /* refused or unsupported */ }
  }

  // ------------------------------------------------------------------ pause
  _pause() {
    if (this.hud.chatOpen) return;
    this.menuOpen = true;
    this.hud.showMenu(true);      // over a blur of the running game
    document.exitPointerLock?.();
  }

  _resume() {
    this.menuOpen = false;
    document.getElementById('designsetup').classList.add('hidden');
    this.hud.showGame(this.input.hasTouch);
    this.input.requestLock();
  }

  // ----------------------------------------------------------------- firing
  _switch(changed) {
    if (!changed) return;
    this.viewmodel.setWeapon(this.loadout.index);
    this._paintGun();
  }

  /** The portal gun wears your agreed pair, on the gun and on the two touch
   *  triggers, and AIM may not latch while it is in hand. */
  _paintGun() {
    const portal = !!this.loadout.weapon.portal;
    const c = this.portals.myColors();
    if (portal) this.viewmodel.setAccents(c.a, c.b);
    this.hud.portalTriggers(portal, c.a, c.b);
    this.input.setHoldOverride('ads', portal);
  }

  _fire(t, input) {
    const p = this.player;
    if (this._stroke) return this._whiteOut(t, input);     // a stroke always gets to finish
    if (!p.alive || this.shielded) return;
    if (this.loadout.weapon.portal) return this._firePortal(t, input);
    if (this.loadout.weapon.erase) return this._whiteOut(t, input);
    const w = this.loadout.tryFire(t, input.down('fire'), input.pressed('fire'));
    if (!w) return;

    const e = p.eye(p.bob);
    const eye = new THREE.Vector3(e.x, e.y, e.z);
    const base = this._aimDirection();
    const moving = Math.hypot(p.vel.x, p.vel.z) > 1.5 || !p.onGround;
    const spread = spreadFor(w, moving, this.adsT);

    // tracers leave the barrel tip on screen: viewmodel space is camera space
    this.camera.updateMatrixWorld(true);
    const muzzle = this.viewmodel.muzzleOffset(new THREE.Vector3())
      .applyMatrix4(this.camera.matrixWorld);

    const damageByPeer = new Map();
    let endPoint = null;
    let tracerPath = null;

    for (let i = 0; i < w.pellets; i++) {
      const dir = base.clone();
      if (spread > 0) {
        dir.x += (Math.random() - 0.5) * spread * 2;
        dir.y += (Math.random() - 0.5) * spread * 2;
        dir.z += (Math.random() - 0.5) * spread * 2;
        dir.normalize();
      }
      const hit = this._raycast(eye, dir, w.range);
      const end = hit.end;
      if (!endPoint) endPoint = end;
      if (!tracerPath) tracerPath = hit.points;

      if (hit.player && !hit.player.shielded) {
        const dmg = w.damage * (hit.head ? HEADSHOT_MULT : 1);
        const e = damageByPeer.get(hit.player.id) || { dmg: 0, head: false, r: hit.player };
        e.dmg += dmg;
        e.head = e.head || hit.head;
        damageByPeer.set(hit.player.id, e);
      } else if (hit.dist < w.range) {
        this.effects.impact(end, dir);
      }
      if (w.pellets > 1) this._drawTracer(muzzle, hit.points, w.color);
    }

    if (w.pellets === 1) this._drawTracer(muzzle, tracerPath, w.color);
    this.effects.muzzle(w.shakeScale);
    this.viewmodel.fire(w.shakeScale);
    this.audio.shot(w.id, 0);
    p.addRecoil(w.recoil, (Math.random() - 0.5) * w.recoilYaw * 2);
    // peers get only the first leg: past a portal the line would cross a wall
    this.net?.shot(muzzle, (tracerPath && tracerPath[1]) || endPoint, w.id);

    let killed = false;
    for (const [id, e] of damageByPeer) {
      this.net?.hit(id, e.dmg, e.head);
      e.r.hit();
      e.r.hp -= e.dmg;     // predicted, corrected by their next state
      if (e.r.hp <= 0) killed = true;
    }
    if (damageByPeer.size) {
      this.hud.hitmarker(killed);
      this.audio.hit();
    }
  }

  /** Two triggers, two colours, a ball from the eye along the aim line. */
  _firePortal(t, input) {
    const p = this.player;
    for (const [action, side] of [['fire', 'a'], ['ads', 'b']]) {
      const w = this.loadout.tryPortalFire(t, input.pressed(action));
      if (!w) continue;
      const eye = p.eye(p.bob);
      const dir = this._aimDirection();
      this.portals.fire(this.portals.selfId, eye, dir, side, false, this.player.up);
      this.effects.muzzle(w.shakeScale);
      this.viewmodel.fire(w.shakeScale);
      this.audio.shot(0, 0);
      p.addRecoil(w.recoil, 0);
      this.net?.portalBall(eye, dir, side, this.player.up);
      return;                      // one portal a frame
    }
  }

  /** White Out. Hold fire and drag: the circle is stamped along the aim as white
   *  paint, and you cannot move while you hold. Let go — or die, or lose the
   *  controls to a menu — and the whole stroke becomes a hole for HOLE_TIME
   *  seconds. Anyone the stroke touches dies then, decided on this screen and sent
   *  as ordinary hits. Peers paint and open the same stamps. */
  _whiteOut(t, input) {
    const p = this.player, w = this.loadout.weapon;
    const ws = this.loadout.state[WHITE_OUT_ID];
    const holding = input.down('fire') && p.alive && !this.shielded && !!w.erase;
    if (!this._stroke) {
      if (!holding || t < ws.readyAt) return;
      this._stroke = { id: Math.floor(Math.random() * 1e9), owner: getSelfId(), o: p.eye(p.bob), last: null };
      this.effects.muzzle(w.shakeScale);
      this.viewmodel.fire(w.shakeScale);
      this.audio.shot(w.id, 0);
    }
    const s = this._stroke;
    if (holding) {
      const d = this._aimDirection();
      if (!s.last) { this._stamp(s, d); s.last = d; return; }
      const angle = Math.acos(clamp(s.last.dot(d), -1, 1));
      if (angle < STAMP_STEP) return;
      // fill the whole drag, however far the aim moved this frame
      const n = Math.ceil(angle / STAMP_STEP);
      for (let i = 1; i <= n; i++) {
        const step = s.last.clone().lerp(d, i / n);
        if (step.lengthSq() > 1e-12) this._stamp(s, step.normalize());
      }
      s.last = d;
      return;
    }

    this._stroke = null;
    const opened = this.world.eraseOpen(s.owner, s.id, now() / 1000);
    // any mouth the stroke took any of is gone for good; decided here, like kills
    const gone = this.portals.erase(q => this.world.eraseHolesOval(s.owner, s.id, q, HALF_W, HALF_H));
    this.net?.eraseOpen(s.id, gone);
    ws.readyAt = t + HOLE_TIME;
    let killed = 0;
    for (const r of this.remotes.values()) {
      if (!r.alive || r.settling || r.shielded) continue;
      if (!opened.some(c => this.world.erase.touchesBody(c, r.pos, r.up, r.height, BODY_RADIUS))) continue;
      this.net?.hit(r.id, 200, false, true);    // 200 is the most _takeHit accepts
      r.hit();
      r.hp = 0;
      killed++;
    }
    if (killed) {
      this.hud.hitmarker(true);
      this.audio.hit();
    }
  }

  _stamp(s, d) {
    if (!this.world.erasePaint(s.o, d, s.owner, s.id)) return;
    this.net?.erasePaint(s.id, s.o, d, this.world.movers.map(m => m.erase.shift));
  }

  _remotePaint(id, m) {
    const d = { x: num(m.dx), y: num(m.dy), z: num(m.dz) };
    if (!Math.hypot(d.x, d.y, d.z)) return;
    // mv: where the shooter's platforms were, three numbers each
    const mv = Array.isArray(m.mv) ? m.mv : [];
    const centres = this.world.movers.map((_, i) => i * 3 + 2 < mv.length
      ? { x: num(mv[i * 3]), y: num(mv[i * 3 + 1]), z: num(mv[i * 3 + 2]) } : null);
    this.world.erasePaint({ x: num(m.x), y: num(m.y), z: num(m.z) }, d, id, num(m.sid), centres);
  }

  _remoteOpen(id, m) {
    const opened = this.world.eraseOpen(id, num(m.sid), now() / 1000);
    for (const kp of Array.isArray(m.kp) ? m.kp : []) {
      if (Array.isArray(kp)) this.portals.remove(String(kp[0]), kp[1] === 'b' ? 'b' : 'a');
    }
    if (!opened.length) return;
    const o = opened[0].o;
    this.audio.shot(WHITE_OUT_ID,
      Math.hypot(o.x - this.player.pos.x, o.y - this.player.pos.y, o.z - this.player.pos.z));
  }

  /** Dying to something that is not a player. */
  _selfDeath(by, label) {
    this.audio.death();
    this.deathAt = now();
    this.hud.setHealth(0);
    this.net?.died(by);
    this.hud.feed(`<b>${label}</b> ▸ <b>${escapeHtml(this.name)}</b>`);
  }

  /** One tracer per leg of the path, the first from the muzzle. */
  _drawTracer(muzzle, points, color) {
    if (!points || points.length < 2) return;
    for (let i = 0; i + 1 < points.length; i += 2) {
      this.effects.tracer(i === 0 ? muzzle : points[i], points[i + 1], color);
    }
  }

  _aimDirection() {
    const p = this.player;
    const pitch = clamp(p.pitch + p.recoil, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    const d = lookFrom(p.up, p.yaw + p.recoilYaw, pitch);
    return new THREE.Vector3(d.x, d.y, d.z).normalize();
  }

  /** Trace a shot through up to SHOT_PORTALS mouths. `points` are the corners
   *  of the path, so the tracer bends; `dist` is the whole distance travelled. */
  _raycast(origin, dir, range) {
    const points = [origin.clone()];
    let o = origin.clone(), d = dir.clone(), left = range, travelled = 0;

    for (let hop = 0; ; hop++) {
      let seg = { dist: this.world.raycast(o, d, left), player: null, head: false };
      for (const r of this.remotes.values()) {
        const h = r.raycast(o, d, seg.dist);
        if (h && h.dist < seg.dist) seg = { dist: h.dist, player: r, head: h.head };
      }

      const gate = hop < SHOT_PORTALS ? this.portals.rayHit(o, d, seg.dist) : null;
      if (gate) {
        const at = o.clone().addScaledVector(d, gate.t);
        const map = portalMap(gate.from, gate.to);
        const out = map.point(at), nd = map.dir(d);
        points.push(at);
        travelled += gate.t;
        left -= gate.t;
        d = new THREE.Vector3(nd.x, nd.y, nd.z).normalize();
        // step off the exit's plane or the ray leaves through the face it arrived at
        o = new THREE.Vector3(out.x, out.y, out.z).addScaledVector(d, 0.02);
        points.push(o.clone());
        if (left > 0.01) continue;
      }

      const end = o.clone().addScaledVector(d, seg.dist);
      points.push(end);
      return { dist: travelled + seg.dist, player: seg.player, head: seg.head, end, points };
    }
  }

  // ------------------------------------------------------------------- loop
  _frame(tMs) {
    requestAnimationFrame(t => this._frame(t));
    const t = tMs / 1000;
    const dt = Math.min(0.05, this._last ? t - this._last : 0.016);
    this._last = t;

    this.world.eraseUpdate(now() / 1000);

    // Platforms move first, and portals ride them in the same breath: a frame of
    // lag sweeps a mouth's plane across whoever is near it. Parked while building.
    if (this.running && !this.design?.ghost) this.world.updateMovers(dt);
    this.portals.update(dt, this.world);

    // peers first, so their hitboxes match the pixels
    for (const r of this.remotes.values()) r.update(dt);

    if (this.running) this._tick(t, dt);

    this.effects.update(dt);
    this.hud.update(dt);

    const r = this.renderer;
    this.portals.selfMouth = this.selfAvatar.mouth;
    this.portals.renderViews(r, this.scene, this.camera);
    r.autoClear = false;
    r.clear();
    r.render(this.scene, this.camera);
    if (!this.design?.ghost) {           // the building ghost carries no gun
      r.clearDepth();
      r.render(this.vmScene, this.vmCamera);
    }
  }

  _tick(t, dt) {
    const p = this.player;
    // with the menu or chat up the world keeps running but takes no commands
    const active = !this.menuOpen && !this.hud.chatOpen && !this.editing;
    const input = active ? this.input : IDLE_INPUT;

    // the flying ghost drives itself; playtest falls through to the match below
    if (this.design && this.design.frame(t, active ? dt : 0)) {
      this._hudTick(dt, input);
      this.input.endFrame();
      return;
    }

    const look = input.consumeLook(dt);
    p.look(look.dx, look.dy);

    for (const [action, index] of [['weapon1', 0], ['weapon2', 1], ['weapon3', 2],
                                   ['weapon4', 3], ['weapon5', WHITE_OUT_ID]]) {
      if (input.pressed(action)) this._switch(this.loadout.switchTo(index, t));
    }
    if (input.pressed('weaponnext')) this._switch(this.loadout.cycle(1, t));
    if (input.pressed('weaponprev')) this._switch(this.loadout.cycle(-1, t));
    if (input.pressed('lastweapon')) this._switch(this.loadout.swapLast(t));
    if (input.pressed('reload') && this.loadout.startReload(t)) this.audio.reload();

    // the portal gun has no sights: its right button is a trigger
    const wantAds = input.down('ads') && !this.loadout.weapon.noAds;
    this.adsT = clamp(this.adsT + (wantAds ? dt : -dt) / ADS_TIME, 0, 1);
    this.hud.ads(this.adsT > 0.5);

    // Painting with White Out holds you where you stand; you can still aim. From
    // the very frame fire goes down, or that frame's step would still walk you.
    const painting = !!this._stroke || (!!this.loadout.weapon.erase && input.down('fire') &&
      p.alive && !this.shielded && t >= this.loadout.state[WHITE_OUT_ID].readyAt);
    if (painting) {
      const u = p.vUp;
      p.vel = { x: p.up.x * u, y: p.up.y * u, z: p.up.z * u };
    }
    p.update(dt, painting ? IDLE_INPUT : input);
    if (p.squashed) {
      p.squashed = false;
      if (p.alive && !this.shielded && p.damage(1000)) this._selfDeath(CRUSHED_BY, 'platform');
    }
    if (p.outOfBounds) {                 // instantly, shield or not
      p.outOfBounds = false;
      console.warn('out of bounds:', JSON.stringify(p.oobWhy));
      if (p.alive && p.damage(1000)) this._selfDeath(OUT_OF_BOUNDS, 'out of bounds');
    }
    if (this.loadout.update(t)) this.audio.reload();

    // camera before firing, so the shot comes from where it is this frame
    this._camera(dt);
    this.selfAvatar.update(p, this.loadout.index);
    this.selfAvatar.setColor(this.myColor ?? PLAYER_COLORS[0]);
    this.selfAvatar.setName(this.name || 'player');
    this.viewmodel.update(dt, p, this.loadout.reloading, this.adsT);
    this._fire(t, input);

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

    if (this.net && !this.design && t - this.lastStateSent > 1 / STATE_HZ) {
      this.lastStateSent = t;
      this.net.broadcastState(p, this.loadout, this.shielded);
    }

    this._hudTick(dt, input);
    this.input.endFrame();
  }

  _camera(dt) {
    const p = this.player;
    const cam = this.camera;

    // zoom narrows the fov; the viewmodel has its own camera and does not swell
    const zoomed = this.baseFov / (1 + (ADS_ZOOM - 1) * this.adsT);
    if (Math.abs(cam.fov - zoomed) > 0.01) {
      cam.fov = zoomed;
      cam.updateProjectionMatrix();
    }

    const shake = this.effects.shake;
    const e = p.eye(p.bob);
    cam.position.set(
      e.x + (Math.random() - 0.5) * shake * 0.1,
      e.y + (Math.random() - 0.5) * shake * 0.1,
      e.z + (Math.random() - 0.5) * shake * 0.1
    );
    const pitch = clamp(p.pitch + p.recoil, -Math.PI / 2, Math.PI / 2);
    const d = lookFrom(p.up, p.yaw + p.recoilYaw, pitch);
    // the horizon rolls into a new up over upBlend rather than snapping
    const u = this._camUp = this._camUp || new THREE.Vector3();
    if (p.upBlend > 0 && p.upFrom) {
      const k = p.upBlend;
      u.set(p.up.x * (1 - k) + p.upFrom.x * k,
            p.up.y * (1 - k) + p.upFrom.y * k,
            p.up.z * (1 - k) + p.upFrom.z * k);
      if (u.lengthSq() < 1e-6) u.set(p.up.x, p.up.y, p.up.z);   // opposite ups
      else u.normalize();
    } else {
      u.set(p.up.x, p.up.y, p.up.z);
    }
    cam.up.copy(u);

    // The basis is built by hand, not with lookAt(), which loses its roll when
    // looking straight along `up` and so could not look straight up or down.
    const X = this._camX = this._camX || new THREE.Vector3();
    const Y = this._camY = this._camY || new THREE.Vector3();
    const Z = this._camZ = this._camZ || new THREE.Vector3();
    Z.set(-d.x, -d.y, -d.z).normalize();      // a camera looks along its -Z
    X.crossVectors(new THREE.Vector3(d.x, d.y, d.z), u);
    if (X.lengthSq() < 1e-8) {                // looking along the horizon's axis
      const r = basisFor(p.up, p.yaw + p.recoilYaw).r;
      X.set(r.x, r.y, r.z);
    }
    X.normalize();
    Y.crossVectors(Z, X);
    this._camM = this._camM || new THREE.Matrix4();
    this._camM.makeBasis(X, Y, Z);
    cam.quaternion.setFromRotationMatrix(this._camM);
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
          `keyboard  fullscreen=${!!document.fullscreenElement} locked=${i.keyboardLocked} ` +
            `blocked=${i.shortcutsBlocked}  <- false here means Ctrl+W still closes the tab`,
          `alt       held=${!!i._altFreed} let go of the lock ${i.altReleases}x  <- counts up on every Alt press`,
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

    this.hud.lockHint(this.input.needsMouseCapture && !this.menuOpen && !this.editing &&
                      !this.hud.chatOpen && !this.design?.mouseFree);

    const left = (this.protectedUntil - now()) / 1000;
    if (this.design) {
      this.hud.protection('');
    } else if (this.editing) {
      this.hud.protection('shielded while editing\nweapon locked');
    } else if (left > 0) {
      this.hud.protection(`shielded · weapon locked ${left.toFixed(1)}s`);
    } else {
      this.hud.protection('');
    }

    const a = this.loadout.ammo, w = this.loadout.weapon;
    // White Out shows its recharge instead of ammunition
    const recharge = w.recharge ? Math.max(0, a.readyAt - (this._last || 0)) : 0;
    if (w.recharge) {
      this.hud.setAmmo(w.name, this._stroke ? 'PAINTING'
        : recharge > 0 ? recharge.toFixed(1) + 's' : 'READY', '', false);
    }
    else if (w.infinite) this.hud.setAmmo(w.name, '∞', '', false);
    else this.hud.setAmmo(w.name, a.mag, a.reserve, this.loadout.reloading);
    // the ring is drawn at the angle the hole really covers, so it grows when aiming
    if (w.erase && !this.design?.ghost) {
      const h = this.canvas.clientHeight || innerHeight;
      const px = Math.tan(ERASE_ANGLE) / Math.tan(this.camera.fov * Math.PI / 360) * h / 2;
      this.hud.eraseReticle(true, Math.round(px), recharge <= 0);
    } else {
      this.hud.eraseReticle(false);
    }
    this.hud.setHealth(this.player.hp);

    // Tab is the playtest switch in a design room, not the scoreboard
    const show = !this.design && (input.down('score') || this.scoreVisible);
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
