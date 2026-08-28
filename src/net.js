import { round2, now } from './util.js';

// Trystero gives us WebRTC mesh networking with no server of our own: public
// relays are used only for the initial handshake, after which every packet is
// peer-to-peer. Nobody hosts anything.
const APP_ID = 'peer-arena-v1';

// Three interchangeable ways for peers to find each other, none of them ours.
// Nostr is the default; the others are there for when a relay set is blocked or
// having a bad day (append &strategy=torrent to the URL).
const STRATEGIES = {
  nostr: 'trystero',
  torrent: 'trystero-torrent',
  mqtt: 'trystero-mqtt'
};

let joinRoom = null;
let selfId = '';
let loading = null;

export function getSelfId() { return selfId; }
export function strategyNames() { return Object.keys(STRATEGIES); }

/** Loads the signalling strategy. Must be awaited before constructing a Net.
 *  Safe (and worthwhile) to call early: the module comes off a CDN, and doing it
 *  while the player is still typing a name takes that wait off the clock between
 *  pressing CONNECT and seeing anyone. Repeat calls share the one load. */
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

export class Net {
  constructor(roomCode, profile, handlers) {
    if (!joinRoom) throw new Error('initNet() must finish before joining a room');
    this.roomCode = roomCode;
    this.profile = profile;              // {name}
    this.h = handlers;
    this.pings = new Map();

    this.room = joinRoom(
      // more relays dialled at once: public ones rate-limit and drop, and the
      // first one to carry the announcement is the one that decides how long a
      // player waits to see anybody
      { appId: APP_ID, relayConfig: { redundancy: 8 } },
      roomCode,
      { onJoinError: e => this.h.onJoinError?.(e) }
    );

    // trystero >= 0.24: makeAction returns {send, onMessage}, and the peer
    // callbacks are properties rather than registration functions
    const act = (name, fn) => this.room.makeAction(name, {
      onMessage: (data, ctx) => fn(data, ctx.peerId)
    });

    this.aState = act('st', (d, id) => this.h.onState?.(id, d));
    this.aHello = act('hi', (d, id) => this.h.onHello?.(id, d));
    this.aShot = act('sh', (d, id) => this.h.onShot?.(id, d));
    this.aHit = act('ht', (d, id) => this.h.onHit?.(id, d));
    this.aDied = act('dd', (d, id) => this.h.onDied?.(id, d));
    this.aChat = act('ch', (d, id) => this.h.onChat?.(id, d));

    this.room.onPeerJoin = id => {
      this.h.onJoin?.(id);
      this.aHello.send({ name: this.profile.name }, { target: id });
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
      } catch { /* peer went away mid-ping */ }
    }
  }

  get peerCount() { return Object.keys(this.room.getPeers()).length; }

  // send() returns a promise; a failed send to a peer that just left must not
  // surface as an unhandled rejection in the middle of a frame
  _send(action, data, options) {
    try {
      const p = action.send(data, options);
      if (p && p.catch) p.catch(() => {});
    } catch { /* channel closed */ }
  }

  broadcastState(player, loadout, shielded) {
    this._send(this.aState, {
      x: round2(player.pos.x), y: round2(player.pos.y), z: round2(player.pos.z),
      a: round2(player.yaw), b: round2(player.pitch),
      h: round2(player.height),
      hp: player.alive ? Math.max(1, Math.round(player.hp)) : 0,
      k: player.kills, d: player.deaths,
      w: loadout.index,
      s: player.spawnSeq,          // lets peers drop interpolation across a teleport
      sf: shielded ? 1 : 0
    });
  }

  shot(from, to, weaponId) {
    this._send(this.aShot, {
      x: round2(from.x), y: round2(from.y), z: round2(from.z),
      tx: round2(to.x), ty: round2(to.y), tz: round2(to.z),
      w: weaponId
    });
  }

  hit(peerId, damage, head) {
    this._send(this.aHit, { dmg: Math.round(damage), head: head ? 1 : 0 }, { target: peerId });
  }

  died(killerId) { this._send(this.aDied, { by: killerId || '' }); }
  chat(text) { this._send(this.aChat, { t: String(text).slice(0, 120) }); }
  hello() { this._send(this.aHello, { name: this.profile.name }); }

  leave() {
    clearInterval(this._pingTimer);
    try { this.room.leave(); } catch { /* already gone */ }
  }
}
