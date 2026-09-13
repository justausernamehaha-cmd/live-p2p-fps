import { upIndex } from './frame.js';
import { round2 } from './util.js';

// Trystero: WebRTC mesh with public relays used only for the handshake.
const APP_ID = 'peer-arena-v1';

// Interchangeable signalling (append &strategy=torrent to the URL if one is blocked).
const STRATEGIES = {
  nostr: 'trystero',
  torrent: 'trystero-torrent',
  mqtt: 'trystero-mqtt'
};

let joinRoom = null;
let selfId = '';
let loading = null;

export function getSelfId() { return selfId; }

/** Load the signalling module; await before constructing a Net. Worth calling
 *  early, and repeat calls share one load. */
export function initNet(strategy = 'nostr') {
  if (!loading) {
    const spec = STRATEGIES[strategy] || STRATEGIES.nostr;
    loading = import(spec).then(mod => {
      joinRoom = mod.joinRoom;
      selfId = mod.selfId;
      return selfId;
    }).catch(err => { loading = null; throw err; });
  }
  return loading;
}

const xyz = (p, prefix = '') =>
  ({ [prefix + 'x']: round2(p.x), [prefix + 'y']: round2(p.y), [prefix + 'z']: round2(p.z) });

export class Net {
  constructor(roomCode, profile, handlers) {
    if (!joinRoom) throw new Error('initNet() must finish before joining a room');
    this.roomCode = roomCode;
    this.profile = profile;              // {name, pr}
    this.h = handlers;
    this.pings = new Map();

    this.room = joinRoom(
      // many relays at once: public ones rate-limit and drop
      { appId: APP_ID, relayConfig: { redundancy: 8 } },
      roomCode,
      { onJoinError: e => this.h.onJoinError?.(e) }
    );

    // trystero >= 0.24: makeAction returns {send, onMessage}
    const act = (name, fn) => this.room.makeAction(name, {
      onMessage: (data, ctx) => fn(data, ctx.peerId)
    });

    this.aState = act('st', (d, id) => this.h.onState?.(id, d));
    this.aHello = act('hi', (d, id) => this.h.onHello?.(id, d));
    this.aShot = act('sh', (d, id) => this.h.onShot?.(id, d));
    this.aHit = act('ht', (d, id) => this.h.onHit?.(id, d));
    this.aDied = act('dd', (d, id) => this.h.onDied?.(id, d));
    this.aChat = act('ch', (d, id) => this.h.onChat?.(id, d));
    // `pb` is the ball for everyone to watch; `pt` is where it landed, decided by
    // the shooter alone so peers can never disagree about a portal's place
    this.aPortalBall = act('pb', (d, id) => this.h.onPortalBall?.(id, d));
    this.aPortal = act('pt', (d, id) => this.h.onPortal?.(id, d));
    // White Out: `er` is one stamp of paint, `eo` opens a whole stroke as holes
    this.aErasePaint = act('er', (d, id) => this.h.onErasePaint?.(id, d));
    this.aEraseOpen = act('eo', (d, id) => this.h.onEraseOpen?.(id, d));
    // a joiner asks the room for its level seed; the first answer wins
    this.aSeedAsk = act('sq', (d, id) => this.h.onSeedAsk?.(id));
    this.aSeedTell = act('sr', (d, id) => this.h.onSeedTell?.(id, d));

    this.room.onPeerJoin = id => {
      this.h.onJoin?.(id);
      this.aHello.send({ name: this.profile.name, pr: this.profile.pr }, { target: id });
    };
    this.room.onPeerLeave = id => {
      this.pings.delete(id);
      this.h.onLeave?.(id);
    };

    this._pingTimer = setInterval(() => this._ping(), 2000);
  }

  async _ping() {
    for (const id of Object.keys(this.room.getPeers())) {
      try {
        const rtt = Math.round(await this.room.ping(id));
        this.pings.set(id, rtt);
        this.h.onPing?.(id, rtt);
      } catch { /* peer left mid-ping */ }
    }
  }

  get peerCount() { return Object.keys(this.room.getPeers()).length; }

  // a failed send to a peer that just left must not become an unhandled rejection
  _send(action, data, options) {
    try {
      const p = action.send(data, options);
      if (p && p.catch) p.catch(() => {});
    } catch { /* channel closed */ }
  }

  broadcastState(player, loadout, shielded) {
    this._send(this.aState, {
      ...xyz(player.pos),
      a: round2(player.yaw), b: round2(player.pitch),
      u: upIndex(player.up),
      h: round2(player.height),
      hp: player.alive ? Math.max(1, Math.round(player.hp)) : 0,
      k: player.kills, d: player.deaths,
      w: loadout.index,
      s: player.spawnSeq,          // changes on every teleport
      sf: shielded ? 1 : 0
    });
  }

  shot(from, to, weaponId) {
    this._send(this.aShot, { ...xyz(from), ...xyz(to, 't'), w: weaponId });
  }

  hit(peerId, damage, head, erased = false) {
    this._send(this.aHit, { dmg: Math.round(damage), head: head ? 1 : 0, er: erased ? 1 : 0 },
               { target: peerId });
  }

  /** One White Out stamp. Direction at four decimals: two would put the cone half
   *  a metre off at sixty metres. */
  erasePaint(stroke, from, dir) {
    const r4 = v => Math.round(v * 1e4) / 1e4;
    this._send(this.aErasePaint, { sid: stroke, ...xyz(from), dx: r4(dir.x), dy: r4(dir.y), dz: r4(dir.z) });
  }

  eraseOpen(stroke) { this._send(this.aEraseOpen, { sid: stroke }); }

  portalBall(from, dir, side, up) {
    this._send(this.aPortalBall, {
      ...xyz(from), ...xyz(dir, 'd'),
      s: side, u: upIndex(up || { x: 0, y: 1, z: 0 })
    });
  }

  /** `m` names the platform the portal is on by index (same on every peer). */
  portal(side, p) {
    this._send(this.aPortal, {
      s: side, ...xyz(p.c), ...xyz(p.n, 'n'), ...xyz(p.u, 'u'), ...xyz(p.v, 'v'), m: p.mover
    });
  }

  askSeed() { this._send(this.aSeedAsk, { }); }
  tellSeed(peerId, seed) { this._send(this.aSeedTell, { sd: String(seed || '') }, { target: peerId }); }

  died(killerId, how = '') { this._send(this.aDied, { by: killerId || '', how }); }
  chat(text) { this._send(this.aChat, { t: String(text).slice(0, 120) }); }
  hello() { this._send(this.aHello, { name: this.profile.name, pr: this.profile.pr }); }

  leave() {
    clearInterval(this._pingTimer);
    try { this.room.leave(); } catch { /* already gone */ }
  }
}
