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
| Weapons | `1` `2` `3` `4`, wheel, `Q` | `WEAPON` |
| Scores | hold `Tab` | `SCORE` |
| Chat | `T` or `Enter` | `CHAT` |
| Menu | `Esc` | `MENU` |
| Input debug overlay | `F3` | — |
| Fullscreen | F11 | button, top right |
| Settings, key bindings | `` ` `` | `LAYOUT`, or `SETTINGS & KEYS` in the menu |
| Rearrange the buttons | — | `LAYOUT`, above the player count |

**Every key can be rebound** from that panel, including **Open settings** and
**Open menu** themselves. Click a key to change it, press **+** to give an action
a *second* key, and press `Backspace` while a key is armed to take just that one
away. A key is taken off whatever else had it, so nothing ends up bound twice,
`Esc` cancels a rebind, and `RESET KEYS` puts the defaults back. The map lives in
`localStorage`, so it survives a reload. Because the settings key can itself be
rebound (or removed), the pause menu carries a `SETTINGS & KEYS` button that
cannot be.

`Esc` also opens the menu whatever `Open menu` is bound to: the browser gives up
the pointer lock on `Esc` no matter what the page wants, and the menu follows.

Crouch, aim, **sprint and jump** can each be set to **hold** or **toggle** in the
same panel. On a keyboard all four rows are simply there; on a touch layout the
row appears for whichever button you select, so you can set it while you are
moving the button around. The choice is remembered per device and applies to
every input for that action — the touch button, the key and the mouse alike.
A latched jump is what makes bunny hopping possible with a thumb: tap `JUMP`
once and the hops keep coming, leaving both thumbs for the stick and the aim.

`Esc` **pauses over the game rather than instead of it** — the match stays on
screen behind a blur, the pointer is released, and the panel is there to use.

Opening the settings panel **shields you and locks your gun**, and both carry on
for three seconds after you close it. That is one window, not two: you cannot be
shot while sorting your keys out, and you cannot edit your way into a free shot
either.

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
| Box or ramp | `F` switches which one you are drawing |
| Draw one on a surface | click the surface, drag the base, click, pull a height, click |
| Floating one | `Q` at one corner, `E` at the opposite one |
| Select anything | `Alt` + `Ctrl` + click — floor, walls and ceiling included |
| Colour it | `1` … `0`, ten colours (`0` is the tenth, not a reset) |
| Turn it | `R` by 90°, `Shift`+`R` by 15°, about the axis `X` selects — **or drag one of its three rings** |
| Delete it | `Delete` — the floor, walls and ceiling cannot be deleted |
| Make it travel | `T` sets the far end to the marker &middot; `Shift`+`T` stops it |
| Grid snap | `G` toggles 0.5 m snapping |
| Cancel | right click, or `Esc` |
| Play what you built | `Tab` — and `Tab` again to go back to building |
| Hide the key list | `H` |

**Every one of those is rebindable too**, from a *Level designer* section that
appears in the settings panel while a design room is open. It is a separate
keyboard from the match's: `R` reloads a rifle and turns a ramp without either
having to give way, because the two modes never run at once.

A shape is drawn on **one surface**, worked out from the first click. The second
point stays on that surface even when the cursor wanders off it, rather than
jumping onto whatever is behind. The height is then pulled along that surface's
normal, and it **can go negative**, which sinks the shape into the surface
instead of standing it out from it.

A **ramp** is the same three clicks. It climbs along whichever way you dragged
further, and its "up" is the surface you drew it on, so a ramp drawn on a wall
leans out of that wall. `R` re-aims it in quarter turns.

Selecting anything that is not the shell puts **three rings** around it, one per
axis. Grab one with the mouse (hold `Alt` to free the pointer) and drag: the
object turns with the ring, snapped to 15° unless `G` has snapping off.

The `Q`/`E` corners are a fixed three metres in front of the eye, with a white
marker sitting there the whole time, so the corner you are about to place is
something you can see rather than something you guess.

### What a level is made of

Everything is still convex, and almost everything is still an axis-aligned box —
which is what keeps collision and hitscan cheap and identical on every peer.
Ramps and anything you turn cannot be, so they become **convex solids** instead:
a list of vertices, the faces between them, and the planes that bound them
(`src/solid.js`). Boxes keep the faster exact path; solids get plane-based
raycasting and a capsule push-out. Nothing is in both lists.

### Playing what you designed

`EXPORT` turns the level into a **seed**: one line that carries the room size,
every box and every colour, with a checksum so a truncated paste is refused
rather than silently half-loaded. Paste it into **ROOM SEED** on the connect
screen and the match is played in that level instead of the arena.

There is no server, so every player in the room needs the same seed — but
`COPY INVITE LINK` bakes it into the URL, so sharing the link is enough.

The level autosaves to `localStorage` while you build, and `CONTINUE THE SAVED
LEVEL` picks it back up.

## The portal gun

The fourth weapon. It is the rifle in the hand — same body, same barrel — except
for the coloured brick on top, which is **two halves**: the left one is the
colour of your left-click portal and the right one the colour of your right.

* **Left click** fires one mouth, **right click** the other. There is no aiming
  down sights with it, because the right button is already the second trigger.
* **It never misses.** Accuracy is 100% standing, running, mid-hop, whatever —
  a portal that lands a foot off is not a near miss, it is the wrong wall.
* It never runs out and never reloads.
* The shot is a small ball, not a hitscan ray. You can watch it fly.

**One pair each.** Firing a third of the same colour replaces the older one.

A portal is an oval **two metres tall and 1.36 wide**, and it goes on any surface
with room for the whole of it — walls, floors, ceilings, ramps, the side of a
moving platform. **No part of one ever hangs off its surface**: shot too near an
edge it slides inward until the whole oval is on the wall, and no further than it
had to. It does not turn once it is placed. Shot at something too small to hold a
portal at all it **explodes and is gone**: the end of a cover wall is one metre
thick and a portal is 1.36 wide, so that wall takes one on its face and never on
its edge.

**Bullets go through them too**, up to two mouths deep, and the tracer bends with
the shot rather than passing through the wall.

**You can see through them.** Each mouth is a window onto whatever is in front of
the other one, rendered from a camera put through the portal exactly the way you
would be — and what you see through one is *exactly* what it covers, not a tinted
or dimmed version of it. Put one in front of you and one behind and you are
looking at yourself, down a corridor that keeps going.

A mouth throws no light of its own, so a portal on the floor beside a wall does
not turn you into a spotlight. Floor and ceiling mouths are turned to the way you
were facing but snapped to the surface's own axes, so the top of a crate takes one
whichever way you happen to be standing.

Anyone can use anyone's portals, which is why the colours matter. With one
player they are blue and orange. As soon as anybody else is in the room every
player is given a **different random pair**, re-rolled on every page refresh, and
no two mouths in the room are ever a similar colour. Nobody hands those out:
each player announces one random number when they join and every machine folds
the same set together, so all of them reach the same answer with no authority
and no negotiation.

Walking in is meant to be easy. Any part of your body through the mouth is you
through it, and the rim counts: brush the very edge with a shoulder and you go
in rather than scraping along it. Standing still in one is enough — a hole you
are already stood in is a hole you fall through. You can stand between two of them without being
thrown about — nothing moving into a mouth means nothing goes through it. And you
**keep everything you had**. Your speed is turned into the
exit's direction, not scrubbed, so a long drop into a portal on the floor comes
out of a wall as a long flat run. Your view is turned with it.

## Moving platforms

Four of them in the arena: two lifts and two shuttles. They travel between two
points at a constant speed and turn round at each end, for ever. Stand on one and
it carries you; step off and you keep only what you were doing yourself. A portal
put on one **rides along with it**, mouth and all.

In the level designer, select an object and press **`T`**: where it is now
becomes the start of its run and the white marker three metres in front of you
becomes the far end, with the object's own middle travelling between them. The
run is drawn as a line while it is selected. **`Shift`+`T`** stops it again.

`T` used to be the designer's delete key; delete is now on **`Delete`**.

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

### Momentum

Three rules hold the movement together, and all three are measured by
`test/momentum.mjs`:

* **A frame that ends in a jump keeps the velocity it arrived with.** Snapping it
  back to the keys at walking pace is what a hop chain must never do, so above
  half a walk the ground rules are skipped entirely on a jumping frame. Below
  that there is nothing to preserve and direct control still applies.
* **Stop hopping and you bleed back down.** Carrying more than a walk while still
  pressing a direction steers and drags; letting go stops you outright.
* **Falling is heavier than rising**, and a drop worth more than 12 m/s of impact
  is paid out as ground speed — up to 8 m/s of it, along the way you are already
  going. Height is worth momentum, which is the same bargain the hop chain makes.

The arena's **stairs are ramps**. The pitch is the same as the flight of
half-metre steps they replaced, so everything that could be climbed still can,
but a run up no longer stutters and a hop chain no longer catches on the nose of
every step.

## Shooting

| | accuracy |
|---|---|
| Aiming (right click / `AIM`) | 100%, moving or still |
| Standing hipfire | 95% |
| Moving hipfire | 90% |
| Portal gun | 100%, always, in every stance |

Aiming raises 1.25× sights over 0.4 s, holds the gun perfectly still, and draws
the crosshair in. The crosshair never blooms — accuracy is a function of stance,
not something the reticle animates. The shotgun keeps its pellet pattern even
aimed, because that is what a shotgun is. Headshots do double damage.

A kill refills the gun in your hands to its full ammo capacity — 150 rifle
rounds, 42 shells, 30 marksman rounds. The magazine still has to be reloaded.

A kill is worth **one magazine** for the gun in hand — 30 rifle, 6 shotgun,
5 marksman — rather than the full refill it used to be.

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
node test/momentum.mjs
node test/slopes.mjs
node test/portals.mjs
node test/solid.mjs      # no browser and no server: the fastest one
node test/portal.mjs     # the other one that needs neither
```

`test/designer.mjs` is the one that matters for the designer, because it refuses
to assert on the designer's own bookkeeping. A drawn box is checked against the
world's collision list; a playtest is checked by the height of the player's feet
once they have fallen; and the seed is checked by loading it in a **second page**
and standing on the level there. Every one of its assertions has been watched go
red with the bug reintroduced.

`test/settings.mjs` proves a rebound key by moving the player with it and by the
old key going dead, a second key by both of them working, and a latched jump by
counting take-offs over two seconds with nothing held down.

`test/momentum.mjs` counts hops by the player leaving the floor, friction by the
speed a second later, and the fall bonus by the difference between a short drop
and a long one from the same standing start.

`test/solid.mjs` and `test/portal.mjs` are the two suites that need neither a
browser nor a server, so they run in about a second each and are worth running
first. `test/portal.mjs` is where the portal arithmetic is proved — that a mouth
only goes where the whole of it fits, that a near miss *slides* to the nearest
place it does, that going through one keeps every bit of the momentum that went
in, and that the colour agreement reaches the same answer on every machine
whatever order the players arrive in. `test/portals.mjs` is its other half and
proves the same things to the *player*, in a browser: it walks into a mouth and
checks where the body came out, drops one through a floor portal and checks the
fall was paid out as speed on the far side, and rides a platform to check it
carries whoever is standing on it. Every claim there has a negative control next
to it — the same walk with the portals taken away has to end somewhere else. `test/slopes.mjs` is its
other half: it proves the geometry means something to the *player*, by walking up
a ramp onto the platform and by checking that a turned wall blocks along the axis
it was turned onto and no longer blocks the one it left.

`test/map.mjs` scans the whole arena floor and asserts that every place you can
stand lets you stand *up*. That is the fault hand-checking missed the first
time: a rooftop with walkable ground underneath and 0.7m of headroom traps a
1.8m player. It re-checks 3600 points, so changing the map's size costs nothing.

`test/movement.mjs` checks that W/A/S/D actually move you in the direction the
camera is looking, at nine different yaws. `test/mechanics.mjs` measures the
movement feel and the protection rule — ground control, latched sprint, the
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
src/solid.js    convex solids: ramps and turned boxes, and how to hit them
src/level.js    a level as data: room size, shapes, colours, and the seed string
src/designer.js the level designer — ghost flight, the tools, rotation, playtest
src/player.js   local movement, collision, step-up, crouch
src/input.js    keyboard + mouse + touch, combined
src/weapons.js  four weapons and their ammo state
src/portal.js   portals as geometry: fitting, traversal, colours (no three.js)
src/portalgun.js the portal gun, the ball, and seeing through a mouth
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
* `src/portal.js` — the size of a portal, how forgiving its mouth is, and how
  far outside it you are put on the way out.
* `src/portalgun.js` — `MAX_VIEWS` and `VIEW_SCALE`: how many mouths redraw the
  world each frame and at what resolution. Seeing through a portal is by a long
  way the most expensive thing this game does.
* `src/level.js` — `MOVE_SPEED`, how fast every moving platform travels.
* `src/player.js` — movement constants at the top (speed, gravity, jump, step
  height), including the fall gravity multiplier and how much of a fall is paid
  out as speed. Stair rise in `world.js` must stay under `STEP_HEIGHT`.
* `src/world.js` — the arena. `add(cx, y, cz, w, h, d, colour)` places a box by
  its centre in x/z and its *bottom* in y; `stairs()` builds a walkable flight.
* `src/remote.js` — `INTERP_DELAY` trades smoothness against how far in the
  past other players are drawn.
