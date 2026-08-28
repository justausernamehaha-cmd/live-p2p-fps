# Live P2P FPS

A browser deathmatch FPS that runs on a PC or a phone and needs **no game
server**. Players connect straight to each other over WebRTC; public Nostr
relays are contacted once, only to introduce peers to one another, and carry no
gameplay traffic.

## Running it

```sh
./serve.sh          # http://localhost:8080, plus the LAN address for a phone
```

ES modules will not load from `file://`, so the game must be served over HTTP —
but any static host will do, and there is nothing to run server-side. Dropping
this folder on GitHub Pages, Netlify, Cloudflare Pages or itch.io is enough to
play with people who are not on your network.

Everyone who opens the same **room code** ends up in the same match. The
`COPY INVITE LINK` button produces a URL with the room baked into the hash.

If a room never finds anyone, the signalling relays are the thing to change —
add `&strategy=torrent` (or `&strategy=mqtt`) to the address, e.g.
`…/#room=iron-4821&strategy=torrent`, and have everyone in the match use the
same one. All three are public infrastructure that only carries the handshake.

## Controls

| | Keyboard + mouse | Touch |
|---|---|---|
| Move | `W` `A` `S` `D` | drag the left of the screen |
| Look | mouse (pointer lock) | drag the right of the screen |
| Fire | left click, `Ctrl` or `F` | `FIRE` button |
| Jump / crouch | `Space` / `C` | `JUMP` / `CROUCH` |
| Sprint | `Shift` | push the stick to its edge |
| Reload | `R` | `RELOAD` |
| Weapons | `1` `2` `3`, wheel, `Q` | `WEAPON` |
| Scores | hold `Tab` | `SCORE` |
| Chat | `T` or `Enter` | `CHAT` |
| Menu | `Esc` | `MENU` |

On a phone, **turn the device sideways**. Portrait works, and the camera widens
its field of view to compensate, but landscape is far better to play in.

**A keyboard paired with a phone or tablet works.** The input layer is additive
rather than modal: the first real key press retires the on-screen thumbstick and
hands movement to `WASD`, while the whole screen stays a look pad for the thumb.
Arrow keys also aim, and `Ctrl`/`F` fire, so a keyboard alone is playable when
there is no mouse. Pointer lock is only requested where it exists.

## How the networking works

Full mesh, no authority. Each peer simulates its own player and broadcasts
position, aim and health 20 times a second; remote players are drawn ~110 ms in
the past and interpolated, so what you see is what you shoot.

Hits are decided by the shooter, against exactly the hitboxes being rendered on
its screen, and sent as a damage message to the victim alone. The victim applies
the damage and announces its own death. This keeps latency compensation honest
between friends but means there is **no cheat protection** — it is a game for
people you know.

## What has been tested

Driven in headless Chromium, two peers at once, over the real public relays:

* both peers found each other and exchanged names, positions and chat;
* movement, jumping, stairs onto the centre platform, mouse-drag aiming;
* firing, ammo, reloads, weapon switching;
* a headshot at 5.8 m — victim took damage, died, respawned, and the killfeed
  and kill counter updated on the shooter's machine;
* the touch thumbstick, look pad and `FIRE` button on a phone-sized viewport;
* **a physical keyboard on that same touch device** — `WASD` drove movement,
  the thumbstick retired itself, and the look pad kept working alongside it.

Frame rate was 25 fps under a software rasteriser, which is the renderer's
floor, not the game's.

## Running the tests

The game itself needs nothing installed. The tests drive it in a real browser:

```sh
npm install && npx playwright install chromium
./serve.sh 8080 &
node test/movement.mjs
```

`test/movement.mjs` checks that W/A/S/D actually move you in the direction the
camera is looking, at nine different yaws. It exists because the movement basis
was once mirrored in z: W and S inverted when facing along z, A and D inverted
when facing along x, and everything felt swapped at the diagonals. The test that
missed it measured only distance travelled, which is happily satisfied by a
player walking backwards.

## Layout

```
index.html      markup for HUD, touch controls and the menu
style.css
src/main.js     wiring, game loop, hit registration
src/world.js    the arena (hand-placed AABBs), merged meshes, raycasting
src/player.js   local movement, collision, step-up, crouch
src/input.js    keyboard + mouse + touch, combined
src/weapons.js  three weapons and their ammo state
src/remote.js   remote player rendering, interpolation, hitboxes
src/net.js      Trystero room and the message actions
src/effects.js  tracers, impacts, muzzle flash, viewmodel
src/audio.js    synthesised gunfire, no audio files
src/hud.js      DOM HUD
```

Three.js and Trystero are pulled from jsDelivr via an import map — there is no
build step and nothing to install. If either fails to load, the page says so
instead of sitting black.

## Tuning

* `src/weapons.js` — damage, fire rate, spread, recoil, magazine sizes.
* `src/player.js` — movement constants at the top (speed, gravity, jump, step
  height). Stair rise in `world.js` must stay under `STEP_HEIGHT`.
* `src/world.js` — the arena. `add(cx, y, cz, w, h, d, colour)` places a box by
  its centre in x/z and its *bottom* in y; `stairs()` builds a walkable flight.
* `src/remote.js` — `INTERP_DELAY` trades smoothness against how far in the
  past other players are drawn.
