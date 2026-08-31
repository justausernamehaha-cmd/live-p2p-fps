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
import { portalMap } from './portal.js';
import { lookFrom, anglesIn, basisFor, upIndex, upFromIndex, UPS } from './frame.js';
import { Net, initNet, getSelfId } from './net.js';
import { clamp, randomRoom, now, num, PLAYER_COLORS, colorIndexFor, cssColor } from './util.js';

const STATE_HZ = 20;
const RESPAWN_TIME = 3;
// One timer, not two. The shield and the weapon lock always ran for the same
// three seconds and always started together, so keeping them apart only made it
// possible for them to disagree — and gave the player two numbers to read where
// there was one thing happening.
const EDIT_PROTECTION = 3000;    // ms carried out of the settings panel
// Joining a room somebody is already playing. Three seconds of shield, with the
// gun locked for the same three, so nobody can drop in and immediately shoot and
// nobody can be shot before the level has finished appearing.
const JOIN_PROTECTION = 3000;
// How long to listen before deciding a room is empty and therefore yours. The
// pre-join usually has the answer before CONNECT is even pressed, so this is the
// cost of making a *new* room, not of joining one.
const SCAN_TIME = 2500;
// ...and how long to wait for somebody in it to say what level it is playing.
const SEED_WAIT = 2500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The one room code that opens the level designer instead of a match. Matched
// before the code is normalised, so `level design` and `level-design` both work.
const DESIGN_CODE = /^level[\s_-]*design(er)?$/i;
// Stands in for a killer that is not a player. Peers read it out of the same
// death message a real kill uses, so the killfeed needs no second channel.
const CRUSHED_BY = '#platform';
// How many mouths one shot may go through. Two is enough for every shape a pair
// of portals can make, and it bounds a pathological loop.
const SHOT_PORTALS = 2;
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
    this.design = null;        // the level designer, while a design room is open
    // ms timestamp; until it passes, incoming damage is ignored and the gun
    // does not fire. You cannot be shot while editing, and you cannot shoot.
    this.protectedUntil = 0;
    this.adsT = 0;             // 0 hipfire, 1 fully aimed; 0.4s each way

    this._initThree();
    this._initInput();
    this._initMenu();
    // fetch the signalling module now rather than when CONNECT is pressed
    initNet(this.strategy).catch(() => { /* reported properly on connect */ });
    this.hud.hideLoading();
    window.__paStarted = true;
    window.game = this;          // handy in the console; also what the test harness pokes at
    window.__spreadFor = spreadFor;
    window.__WEAPONS = WEAPONS;  // test/portals.mjs compares the guns against each other
    window.__frame = { anglesIn, lookFrom, basisFor, UPS };  // test/slopes.mjs and test/tilted.mjs
    window.__air = AIR;          // movement tuning knobs, swept by test/mechanics.mjs
    window.__selfId = getSelfId;
    window.__Level = Level;      // test/designer.mjs decodes seeds with it
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
    // the arena is 120 across and 170 corner to corner, so the fog has to start
    // beyond any sightline that matters or it hides players you should be able to see
    this.scene.fog = new THREE.Fog(0x1b2433, 150, 380);

    // Near plane at 15 mm rather than 50. A body standing in a mouth is astride the
    // surface, and at the rim its eye can be a centimetre or two from the wall
    // beside the hole — at 50 mm that wall was clipped away and you could see
    // straight through it, which is "stand on the edge of a portal and you can see
    // through the wall under it". Far comes in to 400 to pay for the depth
    // precision; the arena is 120 m across, so nothing is lost.
    this.camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.015, 400);
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
    this.portals = new PortalField(this.scene, this.effects);
    this.portals.onPlaced = (side, p) => this.net?.portal(side, p);
    this.player.portals = this.portals;
    // a body of your own, drawn only into portal views: shoot one portal in
    // front of you and one behind, and the person you see is you
    this.selfAvatar = new SelfAvatar(this.scene);
    this.portals.selfView = this.selfAvatar.root;

    addEventListener('resize', () => this._resize());
    addEventListener('orientationchange', () => setTimeout(() => this._resize(), 120));
    visualViewport?.addEventListener('resize', () => this._resize());
    // A field gaining or losing focus is a keyboard coming and going, which is
    // the one viewport change that must not be believed. See _resize().
    addEventListener('focusin', () => this._resize());
    addEventListener('focusout', () => setTimeout(() => this._resize(), 50));
    this._pinScroll();
    // The hint is a button as well as a message: it is the one part of the HUD
    // that takes pointer events, so clicking it captures the mouse rather than
    // falling through to a canvas that is behind it.
    document.getElementById('lockhint').addEventListener('pointerdown', e => {
      e.preventDefault();
      this.input.mouseSeen = true;   // it was clicked with something
      this.input.requestLock(true);
    });
    // Deliberately not "a click anywhere". The canvas already lies under the
    // whole page and takes one; everything drawn over it — the touch buttons,
    // the fullscreen button, the panels — is drawn over it in order to be
    // clicked, and taking the pointer out from under one of those makes it
    // impossible to use. What was actually in the way of capturing the mouse
    // was LEAVE THE ROOM parking the lock and never un-parking it, and a
    // refusal the player could not see waiting out; both are fixed above.
    this._resize();
  }

  /** The page itself never scrolls, on any device.
   *
   *  html and body are already fixed and overflow:hidden, and that is still not
   *  enough: focusing a field scrolls it into view whatever the overflow says,
   *  a phone scrolls the document under a virtual keyboard on its own, and on a
   *  desktop Home, PageDown or a stray wheel over a corner of the page will do
   *  the same. Any of those slides the whole UI up the screen. So the scroll
   *  offset is put back the instant anything moves it.
   *
   *  Only the document is pinned. The menu panel is taller than a phone screen
   *  and scrolls inside itself — that is the only way to reach the CONNECT
   *  button — and pinning it would make the game unstartable. */
  _pinScroll() {
    const pin = () => {
      if (scrollX || scrollY) scrollTo(0, 0);
      for (const el of [document.documentElement, document.body]) {
        if (el.scrollTop) el.scrollTop = 0;
        if (el.scrollLeft) el.scrollLeft = 0;
      }
    };
    addEventListener('scroll', pin, { passive: true });
    // capture, so a scroll inside the menu is seen too: that event does not
    // bubble, and the document may have been dragged along with it
    document.addEventListener('scroll', pin, { capture: true, passive: true });
    pin();
  }

  _resize() {
    // visualViewport is the only measurement that excludes a phone's collapsing
    // URL bar; innerHeight can be taller than what you can actually see
    const w = Math.round(visualViewport?.width || innerWidth);
    let h = Math.round(visualViewport?.height || innerHeight);
    // ...but a virtual keyboard shrinks the visual viewport too, and that is not
    // a smaller screen. Believing it was is what put the arena on screen the
    // moment anyone tapped the room field on a phone: --appvh drives the height
    // of the menu, the canvas behind it is fixed to the whole viewport, and a
    // menu suddenly 300px tall left the default level showing underneath.
    //
    // So while a text field has focus the last height measured without one is
    // kept. focusout re-measures, a moment later, once the keyboard has gone.
    if (isTyping({ target: document.activeElement })) h = this._viewH || h;
    else this._viewH = h;
    document.documentElement.style.setProperty('--appvh', h + 'px');
    const aspect = w / h;
    this.camera.aspect = aspect;
    // A fixed vertical FOV leaves a portrait phone with a ~40° horizontal view,
    // which is unplayable. Widen vertically to claw some of it back (landscape
    // is still much better, and the HUD says so once).
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
    this.input.onKeyboardDetected = () => {
      // a physical keyboard showed up (common on tablets and phones with a
      // Bluetooth keyboard): retire the thumbstick, keep the touch look pad
      document.getElementById('stick').classList.remove('on');
    };
    this.input.onAction = a => {
      // Losing the pointer lock normally means Esc, which should show the menu -
      // but opening the settings panel or the chat box releases it deliberately,
      // and popping the menu over them is not what anyone asked for.
      if (a === 'pause') {
        // the designer releases the pointer on purpose when Alt is held; that is
        // not someone pressing Escape, and it must not throw the menu up
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

    // Ctrl+W and its friends belong to the browser and preventDefault() cannot
    // reach them; only the Keyboard Lock API can, and only in fullscreen. On by
    // default because closing the tab mid-fight is worse than a fullscreen
    // window, and a checkbox because that is a real trade and not ours to make
    // silently.
    const kblock = document.getElementById('kblock');
    const kblockVal = document.getElementById('kblockval');
    // Says what is actually true, not what was asked for. Keyboard lock needs
    // the API, element fullscreen, and a granted request; short of all three the
    // browser still owns Ctrl+W and the panel should not pretend otherwise.
    const showKblock = () => {
      kblockVal.textContent = !kblock.checked ? 'browser keeps them'
        : !navigator.keyboard?.lock ? 'this browser cannot'
        : this.input.shortcutsBlocked ? 'blocked'
        : 'click the game to arm';
    };
    this._showKblock = showKblock;
    kblock.checked = this.input.wantFullscreenLock;
    showKblock();
    kblock.addEventListener('change', () => {
      this.input.setFullscreenLock(kblock.checked);
      showKblock();
    });
    document.addEventListener('fullscreenchange', () => setTimeout(showKblock, 60));
    document.addEventListener('pointerlockchange', () => setTimeout(showKblock, 60));

    // F3 shows exactly what the input layer thinks is happening, so a report of
    // "it did something strange" can be answered with numbers
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

    // A level seed is the whole level in one line. It arrives either from an
    // invite link or from a paste, and it is what makes a designed room playable.
    const seedInput = document.getElementById('seedinput');
    const hashSeed = new URLSearchParams(location.hash.slice(1)).get('seed');
    seedInput.value = hashSeed || localStorage.getItem('pa.seed') || '';
    if (seedInput.value) document.getElementById('seedwrap').open = true;
    this.seedInput = seedInput;

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
      localStorage.setItem('pa.name', name);
      this.name = name;

      // the designer is a room code, not a button, so it is one word to remember
      if (DESIGN_CODE.test(roomInput.value.trim())) return this.openDesignSetup();

      const seed = seedInput.value.trim();
      if (seed) {
        // decoded now only so a broken paste is caught before anything happens;
        // whether it is the level actually played is decided below
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

    // Open settings is itself a binding now, so it can be unbound. This button
    // is the way back in when it has been — and it is shown only while the menu
    // is floating over a running game, because on the connect screen there is no
    // layout to arrange and no game to set up.
    document.getElementById('menusettings').onclick = () => {
      if (!this.running) return;
      // Deliberately not _resume(): that asks for the pointer back, and
      // _startEdit() releases it a millisecond later. The lock can be granted
      // after the release and the mouse stays captured over a panel that exists
      // to be clicked. Close the menu by hand and never ask for the pointer.
      this.menuOpen = false;
      document.getElementById('designsetup').classList.add('hidden');
      this.hud.showGame(this.input.hasTouch);
      this._startEdit();
    };

    shareBtn.onclick = async () => {
      // the seed rides along, so a friend opening the link gets the same level
      // without anyone having to paste eight kilobytes into a chat window
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

  /** Open the room early, without entering the match. */
  async _prejoin(room) {
    if (!room || this.running || DESIGN_CODE.test(room)) return;
    if (this.net && this.net.roomCode === room) return;
    this.net?.leave();
    this.net = null;
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    try {
      await initNet(this.strategy);
      this.net = new Net(room, { name: this.name || 'player', pr: this.portals.myRandom },
                         this._netHandlers());
      this._roomOpenedAt = now();
    } catch (err) {
      console.error(err);   // reported properly if they press CONNECT
    }
  }

  /** CONNECT, from the room code to standing in the match.
   *
   *  A room is not created or joined, it is *found or not found*: there is no
   *  server to ask, so the only way to know whether anybody is already playing
   *  the code you typed is to open it and listen. That is what the scan is.
   *
   *    * nobody there — the room is yours. Your seed is the level, and your code
   *      is the code;
   *    * somebody there — the room already has a level, and it is not a joiner's
   *      business to bring one. Whatever is in the seed box is discarded, the
   *      room's own seed is asked for, and you go in behind a three-second
   *      shield with the gun locked, because dropping into a firefight you have
   *      not seen yet is not a fair way to arrive.
   */
  async _enterRoom(name, room, seed) {
    this.name = name;
    // Leaving a room parks the pointer with the menu, which is right while the
    // menu is up and wrong the moment it is not: without this, connecting again
    // after LEAVE THE ROOM left the mouse permanently uncapturable.
    this.input.suspendLock = false;
    this.hud.status('');
    this.hud.joining('Looking for the room\u2026', `room code ${room}`);
    let found = false;
    try {
      found = await this._scanRoom(room);
    } catch (err) {
      console.error(err);
      this.hud.joining(null);
      this.hud.status('could not reach the signalling relays \u2014 try ' +
        'adding &strategy=torrent to the address: ' + err.message, true);
      return false;
    }

    let level = null;
    this.joinedExisting = found;
    if (!found) {
      // Ours to make. The seed typed in is the level.
      if (seed) {
        try { level = Level.decode(seed); }
        catch (err) { this.hud.joining(null); this.hud.status(err.message, true); return false; }
      }
      this.seed = seed;
    } else {
      this.hud.joining('Joining the room\u2026', 'somebody is already playing this room, so its level is the one you get');
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
      // three seconds of shield, and the gun locked for exactly as long
      this.protectedUntil = now() + JOIN_PROTECTION;
      this.hud.feed('joined an existing room \u2014 shielded for three seconds', 'chat');
      if (seed && seed !== this.seed) {
        this.hud.feed('the room already had a level, so the seed you pasted was not used', 'chat');
      }
    }
    return true;
  }

  /** Open the room and listen. True if anybody else is in it.
   *
   *  The pre-join means this is usually already answered before CONNECT is
   *  pressed — the room was opened while the name was still being typed — so a
   *  peer already known is an immediate yes, and only an empty room costs the
   *  full wait. */
  async _scanRoom(room) {
    await initNet(this.strategy);
    if (!this.net || this.net.roomCode !== room) {
      this.net?.leave();
      for (const r of this.remotes.values()) r.dispose();
      this.remotes.clear();
      this.net = new Net(room, { name: this.name || 'player', pr: this.portals.myRandom },
                         this._netHandlers());
      this._roomOpenedAt = now();
    }
    // The clock runs from when the room was *opened*, not from when CONNECT was
    // pressed. The pre-join usually opened it while the name was still being
    // typed, and time spent listening is time spent listening whoever was
    // watching — so a room that has already been quiet for long enough needs no
    // further wait at all.
    const openedAt = this._roomOpenedAt || now();
    while (now() - openedAt < SCAN_TIME) {
      if (this.net.peerCount > 0) return true;
      await sleep(80);
    }
    return this.net.peerCount > 0;
  }

  /** Ask the room what level it is playing. The first answer wins; silence
   *  means the default arena, which is what a room with no seed is. */
  async _askRoomSeed() {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; this._onSeed = null; resolve(v); } };
      this._onSeed = finish;
      this.net?.askSeed();
      setTimeout(() => finish(null), SEED_WAIT);
    });
  }

  /** Leave the match and go back to the connect screen. */
  leaveRoom() {
    this.net?.leave();
    this.net = null;
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    this.portals.clear();
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
      onPing: (id, rtt) => { const r = this.remotes.get(id); if (r) r.ping = rtt; },
      // somebody new wants to know what level this room is playing
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
        this.net?.leave();
        this.net = new Net(room, { name, pr: this.portals.myRandom }, this._netHandlers());
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
    // their portals go with them: a mouth nobody owns is a mouth nobody can
    // replace, and it would sit on the wall for the rest of the match
    this.portals.forget(id);
    this._recolour();
  }

  _remote(id) {
    let r = this.remotes.get(id);
    if (!r) {
      r = new RemotePlayer(id, this.scene);
      r.portals = this.portals;    // so their other half can be drawn out of a mouth
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

    // Portal colours are agreed the same way, but they cannot be derived from
    // the id alone: they have to be different on every refresh, so each player
    // announces one random number and everybody folds the same set together.
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
    if (!Math.hypot(n.x, n.y, n.z)) return;      // a peer sending nonsense
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
      this.net.died(fromId);
      const killer = this.remotes.get(fromId);
      // your own name, not "you": the killfeed reads the same on every screen,
      // and yours is the one line on it you might want to screenshot
      this.hud.feed(`<b>${escapeHtml(killer ? killer.name : 'someone')}</b> ▸ ` +
                    `<b>${escapeHtml(this.name)}</b>`);
    }
  }

  _someoneDied(victimId, m) {
    const victim = this.remotes.get(victimId);
    const killerName = m.by === CRUSHED_BY ? 'platform'
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

  // ------------------------------------------------------------ level design
  /** The room-size chooser. Also the way back out of a level already open. */
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

    const num = (id, lo, hi, fallback) => {
      const v = Number(document.getElementById(id).value);
      return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
    };
    document.getElementById('dstart').onclick = () => {
      this._enterDesign(new Level(num('dw', MIN_W, MAX_W, 60),
                                 num('dl', MIN_W, MAX_W, 60),
                                 num('dh', MIN_H, MAX_H, 14)));
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
    // a design room is single-player by definition: drop any signalling the
    // pre-join may already have opened, so nobody can wander in
    this.net?.leave();
    this.net = null;
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();

    this.room = 'level design';
    this.seed = '';
    this.portals.clear();      // a new level's walls are not the old level's
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
    // the panel is there to be clicked: nothing may quietly take the mouse back
    this.input.suspendLock = true;
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
    this.input.suspendLock = false;
    this.layout.exit();
    // protection does not vanish the instant the panel closes, but it does not
    // linger either: three seconds to get to cover, and the gun is dead for
    // exactly as long, so nobody can edit their way into a free shot
    this.protectedUntil = now() + EDIT_PROTECTION;
    this._relock();
  }

  /** True while incoming damage is ignored — and, for the same window, while
   *  the gun will not fire. The two are one state. */
  get shielded() { return this.editing || now() < this.protectedUntil; }

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
    // Paused over the game rather than instead of it: the world stays on screen
    // behind a blur, and the mouse is free to use the panel.
    this.hud.showMenu(true);
    document.exitPointerLock?.();
  }

  _resume() {
    this.menuOpen = false;
    document.getElementById('designsetup').classList.add('hidden');
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
    this._paintGun();
  }

  /** The portal gun's brick wears the player's own pair — blue on the left and
   *  orange on the right on your own, until somebody else joins and everybody's
   *  colours are re-agreed. Every other gun keeps the brick it has always had.
   *
   *  The same pair goes onto the two touch buttons, because with this gun in
   *  hand FIRE is the left mouth and AIM is the right one — and AIM has to stop
   *  latching while that is true, or a player who prefers a toggled aim would
   *  place a portal on every other tap. */
  _paintGun() {
    const portal = !!this.loadout.weapon.portal;
    const c = this.portals.myColors();
    if (portal) this.viewmodel.setAccents(c.a, c.b);
    this.hud.portalTriggers(portal, c.a, c.b);
    this.input.setHoldOverride('ads', portal);
  }

  _fire(t, input) {
    const p = this.player;
    if (!p.alive || this.shielded) return;
    if (this.loadout.weapon.portal) return this._firePortal(t, input);
    const w = this.loadout.tryFire(t, input.down('fire'), input.pressed('fire'));
    if (!w) return;

    const e = p.eye(p.bob);
    const eye = new THREE.Vector3(e.x, e.y, e.z);
    const base = this._aimDirection();
    const moving = Math.hypot(p.vel.x, p.vel.z) > 1.5 || !p.onGround;
    const spread = spreadFor(w, moving, this.adsT);

    // the tracer leaves the barrel tip of the gun actually on screen: read its
    // position out of the viewmodel scene (which is camera space) and put it
    // into the world with the camera's own transform
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
    // peers get the first leg only: past a portal the line would cut across the
    // map, and a tracer through a wall reads as a bug rather than as a portal
    this.net?.shot(muzzle, (tracerPath && tracerPath[1]) || endPoint, w.id);

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

  /** The portal gun. Two triggers, two colours, and a ball rather than a ray.
   *
   *  The ball leaves from the eye along the aim line rather than from the muzzle,
   *  which is what makes it land exactly on the crosshair; it is invisible for
   *  its first stride so it still looks like it came out of the gun. */
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
      return;                      // one portal a frame, whatever is held
    }
  }

  /** One tracer per leg of the path, the first starting at the gun's own muzzle
   *  rather than at the eye. */
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

  /** Trace a shot, through any portals it meets on the way.
   *
   *  Returns where it ended and who it hit, plus `points` — the corners of the
   *  path it actually took, so the tracer can be drawn bent instead of passing
   *  straight through a wall. `dist` is the whole distance travelled, which is
   *  what the weapon's range is spent on. */
  _raycast(origin, dir, range) {
    const points = [origin.clone()];
    let o = origin.clone(), d = dir.clone(), left = range, travelled = 0;

    for (let hop = 0; ; hop++) {
      let seg = { dist: this.world.raycast(o, d, left), player: null, head: false };
      for (const r of this.remotes.values()) {
        const h = r.raycast(o, d, seg.dist);
        if (h && h.dist < seg.dist) seg = { dist: h.dist, player: r, head: h.head };
      }

      // a mouth in the way, before anything solid or anybody standing there
      const gate = hop < SHOT_PORTALS ? this.portals.rayHit(o, d, seg.dist) : null;
      if (gate) {
        const at = o.clone().addScaledVector(d, gate.t);
        const map = portalMap(gate.from, gate.to);
        const out = map.point(at), nd = map.dir(d);
        points.push(at);
        travelled += gate.t;
        left -= gate.t;
        d = new THREE.Vector3(nd.x, nd.y, nd.z).normalize();
        // step off the exit's own plane, or the ray leaves through the face it
        // just arrived at and the shot stops dead in the wall it came out of
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

    // The level moves before anybody in it does: a platform's position this
    // frame is what the player's collision, the portals stuck to it and the
    // hitscan all have to agree on. Platforms are parked while the designer's
    // ghost is flying — a box that wanders off mid-edit cannot be built with.
    if (this.running && !this.design?.ghost) this.world.updateMovers(dt);
    // Portals stuck to platforms ride them here, in the same breath — not after
    // the player has moved. A frame of lag between a platform and the mouth on
    // it sweeps the mouth's plane back and forth across whoever is near it, and
    // a portal under a lift would throw them across the map at random.
    this.portals.update(dt, this.world);

    // remote players are advanced first so their hitboxes match the pixels
    for (const r of this.remotes.values()) r.update(dt);

    if (this.running) this._tick(t, dt);

    this.effects.update(dt);
    this.hud.update(dt);

    const r = this.renderer;
    // what is on the other side of each mouth, before anything is drawn for real
    this.portals.renderViews(r, this.scene, this.camera);
    r.autoClear = false;
    r.clear();
    r.render(this.scene, this.camera);
    // A ghost is not carrying a rifle, and the viewmodel would sit in front of
    // everything it is trying to point at
    if (!this.design?.ghost) {
      r.clearDepth();                     // the gun is drawn over everything
      r.render(this.vmScene, this.vmCamera);
    }
  }

  _tick(t, dt) {
    const p = this.player;
    // while the menu or chat box is up the world keeps simulating (this is an
    // online game — you are still standing there) but stops taking commands
    const active = !this.menuOpen && !this.hud.chatOpen && !this.editing;
    const input = active ? this.input : IDLE_INPUT;

    // The ghost flies, aims and builds on its own terms, and drives the camera
    // itself; the playtest half of the designer falls through to everything below.
    if (this.design && this.design.frame(t, active ? dt : 0)) {
      this._hudTick(dt, input);
      this.input.endFrame();
      return;
    }

    const look = input.consumeLook(dt);
    p.look(look.dx, look.dy);

    if (input.pressed('weapon1')) this._switch(this.loadout.switchTo(0, t));
    if (input.pressed('weapon2')) this._switch(this.loadout.switchTo(1, t));
    if (input.pressed('weapon3')) this._switch(this.loadout.switchTo(2, t));
    if (input.pressed('weapon4')) this._switch(this.loadout.switchTo(3, t));
    if (input.pressed('weaponnext')) this._switch(this.loadout.cycle(1, t));
    if (input.pressed('weaponprev')) this._switch(this.loadout.cycle(-1, t));
    if (input.pressed('lastweapon')) this._switch(this.loadout.swapLast(t));
    if (input.pressed('reload') && this.loadout.startReload(t)) this.audio.reload();

    // sights come up and go down at a constant rate. The portal gun has none:
    // its right button is the orange trigger, so aiming with it would both zoom
    // and fire, which is two things one button must not do.
    const wantAds = input.down('ads') && !this.loadout.weapon.noAds;
    this.adsT = clamp(this.adsT + (wantAds ? dt : -dt) / ADS_TIME, 0, 1);
    this.hud.ads(this.adsT > 0.5);

    p.update(dt, input);
    // A platform closed on the player. Death is dealt here rather than in the
    // movement code, because dying is the game's business and not the body's.
    if (p.squashed) {
      p.squashed = false;
      if (p.alive && !this.shielded && p.damage(1000)) {
        this.audio.death();
        this.deathAt = now();
        this.hud.setHealth(0);
        this.net?.died(CRUSHED_BY);
        this.hud.feed(`<b>platform</b> ▸ <b>${escapeHtml(this.name)}</b>`);
      }
    }
    if (this.loadout.update(t)) this.audio.reload();

    // camera and viewmodel first: the shot is traced from where they actually
    // are this frame, not from where they were on the last one
    this._camera(dt);
    this.selfAvatar.update(p, this.loadout.index);
    this.selfAvatar.setColor(this.myColor ?? PLAYER_COLORS[0]);
    this.selfAvatar.setName(this.name || 'player');
    this.viewmodel.update(dt, p, this.loadout.reloading, this.adsT);
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

    // zoom by narrowing the field of view; the viewmodel keeps its own camera and
    // its own fov, so the gun does not swell as the world magnifies
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
    // The horizon is the player's own, not the world's: come out of a portal
    // standing on a wall and the room is what has turned over, not you.
    const pitch = clamp(p.pitch + p.recoil, -Math.PI / 2, Math.PI / 2);
    const d = lookFrom(p.up, p.yaw + p.recoilYaw, pitch);
    // The horizon rolls into place rather than snapping: `upBlend` runs 1 -> 0
    // over the fifth of a second after the body turned over, and only the camera
    // ever sees the in-between.
    const u = this._camUp = this._camUp || new THREE.Vector3();
    if (p.upBlend > 0 && p.upFrom) {
      const k = p.upBlend;
      u.set(p.up.x * (1 - k) + p.upFrom.x * k,
            p.up.y * (1 - k) + p.upFrom.y * k,
            p.up.z * (1 - k) + p.upFrom.z * k);
      // two opposite ups have no plane between them; lean on the look direction
      if (u.lengthSq() < 1e-6) u.set(p.up.x, p.up.y, p.up.z);
      else u.normalize();
    } else {
      u.set(p.up.x, p.up.y, p.up.z);
    }
    cam.up.copy(u);

    // The basis, written out rather than left to lookAt().
    //
    // lookAt takes the roll from `cam.up` by crossing it with the look
    // direction, which is exactly zero when you look straight up or straight
    // down — so the pitch had to stop a hundredth of a radian short of both, and
    // "I should be able to look directly down and up" was not possible. Across
    // the view is the player's own flat right vector, which is defined at every
    // pitch: at 90 degrees it is still the direction yaw says is to your right.
    const X = this._camX = this._camX || new THREE.Vector3();
    const Y = this._camY = this._camY || new THREE.Vector3();
    const Z = this._camZ = this._camZ || new THREE.Vector3();
    Z.set(-d.x, -d.y, -d.z).normalize();      // a camera looks along its own -Z
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
    this.hud.lockHint(this.input.needsMouseCapture && !this.menuOpen && !this.editing &&
                      !this.hud.chatOpen && !this.design?.mouseFree);

    // shield and fire lock are only ever shown to the player they apply to
    const t = now();
    const left = (this.protectedUntil - t) / 1000;
    if (this.design) {
      this.hud.protection('');            // nobody to be shielded from in here
    } else if (this.editing) {
      this.hud.protection('shielded while editing\nweapon locked');
    } else if (left > 0) {
      this.hud.protection(`shielded · weapon locked ${left.toFixed(1)}s`);
    } else {
      this.hud.protection('');
    }

    const a = this.loadout.ammo, w = this.loadout.weapon;
    if (w.infinite) this.hud.setAmmo(w.name, '\u221e', '', false);
    else this.hud.setAmmo(w.name, a.mag, a.reserve, this.loadout.reloading);
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
