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

One room code is special: type **`level design`** and you get the level designer
instead of a match. See [Designing a level](#designing-a-level).

If a room never finds anyone, the signalling relays are the thing to change —
add `&strategy=torrent` (or `&strategy=mqtt`) to the address, e.g.
`…/#room=iron-4821&strategy=torrent`, and have everyone in the match use the
same one. All three are public infrastructure that only carries the handshake.

## Controls

| | Keyboard + mouse | Touch |
|---|---|---|
| Move | `W` `A` `S` `D` | drag the left of the screen |
| Look | mouse (pointer lock) | drag anywhere on the right — including across a button |
| Fire | left click, or `F` | `FIRE` |
| Aim | right click | `AIM` |
| Jump | `Space` | `JUMP` |
| Crouch | `Ctrl` or `C` | `CROUCH` |
| Sprint | `Shift` | `SPRINT`, or push the stick to its edge |
| Reload | `R` | `RELOAD` |
| Weapons | `1` `2` `3`, wheel, `Q` | `WEAPON` |
| Scores | hold `Tab` | `SCORE` |
| Chat | `T` or `Enter` | `CHAT` |
| Menu | `Esc` | `MENU` |
| Input debug overlay | `F3` | — |
| Fullscreen | F11 | button, top right |
| Settings, key bindings | `` ` `` or `=` | `LAYOUT`, above the player count |
| Rearrange the buttons | — | `LAYOUT`, above the player count |

**Every key can be rebound** from that panel: click the key beside an action and
press the one you want. It takes the key off whatever else had it, so nothing
ends up bound twice, and `RESET KEYS` puts the defaults back. The map lives in
`localStorage`, so it survives a reload.

Crouch, aim, **sprint and jump** can each be set to **hold** or **toggle** in the
same panel. On a keyboard all four rows are simply there; on a touch layout the
row appears for whichever button you select, so you can set it while you are
moving the button around. The choice is remembered per device and applies to
every input for that action — the touch button, the key and the mouse alike.
A latched jump is what makes bunny hopping possible with a thumb: tap `JUMP`
once and the hops keep coming, leaving both thumbs for the stick and the aim.

`Esc` **pauses over the game rather than instead of it** — the match stays on
screen behind a blur, the pointer is released, and the panel is there to use.

On a phone, **turn the device sideways**. Portrait works, and the camera widens
its field of view to compensate, but landscape is far better to play in.

**A keyboard paired with a phone or tablet works.** The input layer is additive
rather than modal: the first real key press retires the on-screen thumbstick and
hands movement to `WASD`, while the whole screen stays a look pad for the thumb.
Arrow keys also aim, and `Ctrl`/`F` fire, so a keyboard alone is playable when
there is no mouse. Pointer lock is only requested where it exists.

## Designing a level

Type **`level design`** as the room code. Nobody else can join that room: the
designer is single-player by construction, and no signalling connection is
opened at all.

You start by choosing the room's **width, length and height** in metres. That
box is the world — a ghost cannot leave it, and nothing can be built outside it.

| | |
|---|---|
| Fly | `W` `A` `S` `D`, along the look direction — nose up and press forward to rise |
| Faster | `Shift` |
| Straight up / down | `Space` / `C` |
| Free the mouse | hold `Alt` — also how you reach the panel's buttons |
| Draw a box on a surface | click the surface, drag the rectangle, click, pull a height, click |
| Floating box | `Q` at one corner, `E` at the opposite one |
| Select anything | `Alt` + `Ctrl` + click — floor, walls and ceiling included |
| Colour it | `1` … `0`, ten colours (`0` is the tenth, not a reset) |
| Delete it | `R` — the floor, walls and ceiling cannot be deleted |
| Grid snap | `G` toggles 0.5 m snapping |
| Cancel | right click, or `Esc` |
| Play what you built | `Tab` — and `Tab` again to go back to building |
| Hide the key list | `H` |

A rectangle is drawn on **one surface**, worked out from the first click. The
second point stays on that surface even when the cursor wanders off it, rather
than jumping onto whatever is behind. The height is then pulled along that
surface's normal, and it **can go negative**, which sinks the box into the
surface instead of standing it out from it.

The `Q`/`E` corners are a fixed three metres in front of the eye, with a white
marker sitting there the whole time, so the corner you are about to place is
something you can see rather than something you guess.

### Playing what you designed

`EXPORT` turns the level into a **seed**: one line that carries the room size,
every box and every colour, with a checksum so a truncated paste is refused
rather than silently half-loaded. Paste it into **ROOM SEED** on the connect
screen and the match is played in that level instead of the arena.

There is no server, so every player in the room needs the same seed — but
`COPY INVITE LINK` bakes it into the URL, so sharing the link is enough.

The level autosaves to `localStorage` while you build, and `CONTINUE THE SAVED
LEVEL` picks it back up.

## Movement

Ground movement is direct: the input *is* your velocity, so you turn on the spot
and stop dead, with no acceleration ramp and no slide.

In the air it changes character, because that is where bunny hopping lives. Only
the strafe keys steer, and acceleration is granted only up to a small budget of
speed *along the direction you are pushing*. Hold `W` in the air and you have
already spent that budget, so nothing happens. Hold a strafe key and turn the
view the same way, and every frame pays out. Chained jumps keep what you built —
a frame that ends in a jump pays no ground friction — so a good run climbs from
6.2 m/s walking to somewhere north of 13, while holding `W` and hammering jump
gets you exactly walking speed and no more.

Momentum is yours once you have it. A heavy landing keeps it, running up stairs
keeps it, and flipping from `A` to `D` in mid-air redirects it rather than
scrubbing it off — air control can only ever turn or add to your speed, never
brake. Bumping into something is the one way to lose it: any surface that actually
stops you, head-on or glancing, collapses a hop chain back to running speed.

Sprint latches: tap `Shift` once and you keep sprinting until you release
forward. Crouching takes 0.3 s each way so it cannot be flickered, and stairs are
climbed as a straight line — the body steps up instantly for collision, the view
follows at a constant rate.

## Shooting

| | accuracy |
|---|---|
| Aiming (right click / `AIM`) | 100%, moving or still |
| Standing hipfire | 95% |
| Moving hipfire | 90% |

Aiming raises 1.25× sights over 0.4 s, holds the gun perfectly still, and draws
the crosshair in. The crosshair never blooms — accuracy is a function of stance,
not something the reticle animates. The shotgun keeps its pellet pattern even
aimed, because that is what a shotgun is. Headshots do double damage.

A kill refills the gun in your hands to its full ammo capacity — 150 rifle
rounds, 42 shells, 30 marksman rounds. The magazine still has to be reloaded.

## A note on mouse input

While the mouse is captured, every keystroke is swallowed except `Esc`, so
browser shortcuts cannot fire mid-fight. In fullscreen the reserved combinations
go too, via the Keyboard Lock API.

Pressing a mouse button physically disturbs the mouse, and pointer acceleration
turns a few millimetres into tens of reported pixels, which lands as a view jolt.
Two things guard against it: the lock is requested with `unadjustedMovement`, which turns
OS acceleration off where the browser supports it (F3 shows `raw=true` when it
was granted), and movement is capped per event: dropped entirely for the first 80ms after any
button edge, throttled to about a degree until 170ms, and capped at roughly six
degrees otherwise. Button edges are watched globally and for every button,
because a second button pressed while another is held may not be delivered to
the canvas at all — that gesture was the one still shifting the view. Sustained turning still reaches ~380 degrees a second.

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
  the thumbstick retired itself, and the look pad kept working alongside it;
* the level designer end to end: a room built, played in, exported, and the seed
  loaded in a **second browser page that never saw the designer**, where the
  player stood on the box the designer had made.

Frame rate was 25 fps under a software rasteriser, which is the renderer's
floor, not the game's.

## Running the tests

The game itself needs nothing installed. The tests drive it in a real browser:

```sh
npm install && npx playwright install chromium
./serve.sh 8080 &
node test/movement.mjs
node test/mechanics.mjs
node test/stuckkeys.mjs
node test/pointerlock.mjs
node test/mouselook.mjs
node test/mousebuttons.mjs
node test/holdtoggle.mjs
node test/map.mjs
node test/designer.mjs
node test/settings.mjs
```

`test/designer.mjs` is the one that matters for the designer, because it refuses
to assert on the designer's own bookkeeping. A drawn box is checked against the
world's collision list; a playtest is checked by the height of the player's feet
once they have fallen; and the seed is checked by loading it in a **second page**
and standing on the level there. Every one of its assertions has been watched go
red with the bug reintroduced.

`test/settings.mjs` proves a rebound key by moving the player with it and by the
old key going dead, and a latched jump by counting take-offs over two seconds
with nothing held down.

`test/map.mjs` scans the whole arena floor and asserts that every place you can
stand lets you stand *up*. That is the fault hand-checking missed the first
time: a rooftop with walkable ground underneath and 0.7m of headroom traps a
1.8m player. It re-checks 3600 points, so changing the map's size costs nothing.

`test/movement.mjs` checks that W/A/S/D actually move you in the direction the
camera is looking, at nine different yaws. `test/mechanics.mjs` measures the
movement feel and the protection rules — ground control, latched sprint, the
crouch animation, stair smoothing, bunny-hop speed gain, aiming, and the layout
editor's shield. It exists because the movement basis
was once mirrored in z: W and S inverted when facing along z, A and D inverted
when facing along x, and everything felt swapped at the diagonals. The test that
missed it measured only distance travelled, which is happily satisfied by a
player walking backwards.

## Layout

```
index.html      markup for HUD, touch controls and the menu
style.css
src/main.js     wiring, game loop, hit registration
src/world.js    boxes, merged meshes, raycasting, and the built-in arena
src/level.js    a level as data: room size, boxes, colours, and the seed string
src/designer.js the level designer — ghost flight, the box tools, playtest
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
