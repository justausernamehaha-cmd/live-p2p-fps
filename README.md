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

Everyone who opens the same **room code** ends up in the same match. Pressing
CONNECT opens that room and listens before it does anything else — there is no
server to ask whether a room exists, so the only way to find out is to knock:

* **nobody there** — the room is yours. Your code is the code, and whatever is
  in the `Room seed` box is the level;
* **somebody there** — the room already has a level, so the seed box is ignored
  and the room's own seed is fetched from whoever is in it. You drop in behind a
  three-second shield with the gun locked for the same three seconds.

`LEAVE THE ROOM` in the menu takes you back to this screen. The
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
| Left / right portal | left / right click | `LEFT PORTAL` / `RIGHT PORTAL` |
| Jump | `Space` | `JUMP` |
| Crouch | `Ctrl` or `C` | `CROUCH` |
| Reload | `R` | `RELOAD` |
| Weapons | `1` `2` `3` `4` `5`, wheel, `Q` | `WEAPON` |
| Scores | hold `Tab` | `SCORE` |
| Chat | `T` or `Enter` | `CHAT` |
| Menu | `Esc` | `MENU` |
| Input debug overlay | `F3` | — |
| Fullscreen | F11 | button, top right |
| Settings, key bindings | `` ` `` | `LAYOUT`, or `SETTINGS & KEYS` while paused |
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

Crouch, aim **and jump** can each be set to **hold** or **toggle** in the
same panel. On a keyboard all three rows are simply there; on a touch layout the
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
Arrow keys also aim, and `F` fires, so a keyboard alone is playable when
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
  On a phone the `FIRE` and `AIM` buttons say **LEFT PORTAL** and **RIGHT
  PORTAL** while it is in your hands, in the two colours the mouths will be — and
  `AIM` stops latching for as long as it does, so every tap places a mouth even
  if you have it set to toggle.
* **It never misses.** Accuracy is 100% standing, running, mid-hop, whatever —
  a portal that lands a foot off is not a near miss, it is the wrong wall.
* It never runs out and never reloads.
* The shot is a small ball, not a hitscan ray. You can watch it fly — barely.

**One pair each.** Firing a third of the same colour replaces the older one.
**No two mouths may overlap**, whoever they belong to: a shot that would lay one
over another explodes instead.

A portal is an oval **two metres tall and 1.36 wide** — and "tall" means tall to
*you*: its long axis follows whichever way is up for whoever fired it, so
somebody standing on a wall gets a doorway rather than a letterbox. It goes on
any surface
with room for the whole of it — walls, floors, ceilings, ramps, the side of a
moving platform. **No part of one ever hangs off its surface**: shot too near an
edge it slides inward until the whole oval is on the wall, and no further than it
had to. **If it will not fit upright but will on its side, it turns a quarter
and lies down** — a strip too short for a doorway still takes a portal — **and
if it fits neither way it turns to whatever angle the surface does take**, the
least turn from upright first: a square too small both ways holds one on its
diagonal, a strip lying at an angle to the grid holds one along itself, a
triangle holds one along its long edge. A turned mouth turns you with it, the
way a lying one always has. It does not turn once it is placed. Shot at
something too small to hold a portal at any angle it **explodes and is gone**:
the end of a cover wall is one metre thick and a portal is 1.36 wide, so that
wall takes one on its face and never on its edge.

**Bullets go through them too**, up to two mouths deep, and the tracer bends with
the shot rather than passing through the wall.

**A mouth in a platform is a hole in a platform.** Shoot one at the underside of
a lift and stand where it is coming down, and it takes you through instead of
crushing you — the only way out of a crush there is.

**You are not teleported.** A portal is a hole, and you go through it the way
anything goes through a hole — a bit at a time. Walk into one and the wall it is
cut into stops being solid for you, so you can stop halfway and **stand there,
half out of one mouth and half out of the other**; everyone else sees both halves
of you, and so do you if you look at the mouth you are hanging out of. The moment
your **camera** passes the surface — or the middle of you does, whichever gets
there first — the whole body is re-expressed on the far side: position, speed,
view, and which way is up, so nothing on screen moves at all. The camera is what
you are, which is why it is the one that decides; the middle is still asked as
well, because a mouth lying on a ramp needs it.

And the wall a mouth is cut into keeps every bit of itself that is not the
mouth. Walk sideways out of a hole and the wall is there; stand on a wall and
walk at a mouth cut into it and the wall is there until you are over the hole;
stand *behind* a wall and a mouth on its far side is not a door for you. If you
do not fit through the oval you do not go through it.

Because it is a hole rather than a magnet, sliding along a wall *past* a mouth
does not pull you in. You have to walk into it.

**Gravity comes with you.** Where your feet point is where you fall: go up
through a mouth in a ceiling and out of one on a wall, and you are standing on
that wall with the room on its side. The horizon rolls over rather than snapping.
**Only a portal ever changes which way you fall** — nothing you walk on will turn
you over — so getting back upright means shooting your way back, which is the
point of it.

Gravity can point at **45 degrees**, not only along an axis. Every slope in the
game is 45 degrees, so a mouth on one turns you by 45 degrees, and that is the
answer you get rather than a guess at whichever axis was nearer. There are
eighteen directions up can be: the six axes and the twelve diagonals between
them. Standing at 45 degrees you still land, still walk where you are looking,
and still fall the way your feet point — a tilted body is collided as the capsule
it is rather than as a box that no longer fits it. What a tilted body does not
get: the stair step-up, and being carried or crushed by a moving platform.

Every inside corner of the room, floor and ceiling alike, carries a **45-degree
fillet**, sitting flush against both surfaces it joins. They are there because
for somebody standing on a wall the corner would otherwise be a sheer face with
nothing walkable between the wall and the floor — and because a portal goes on
one perfectly well.

The arena and every designed room are **closed boxes** — floor, four walls and a
ceiling — so however your gravity is pointing there is always something to land
on, and a ceiling is one more surface to put a mouth on.

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

Walking in is meant to be easy. Any part of your body in the mouth is you in it,
and the rim counts: brush the very edge with a shoulder and you are in rather
than scraping along it. A mouth in the floor you are standing on is a hole you
fall through.

**Put one at your feet and one over your head and you fall for ever**, faster
every time round, up to the same 80 m/s terminal any fall has. Nothing resets on
the way through, and nothing is capped: the crossing hands over exactly what
arrived at it, so a long drop into a portal on the floor comes out of a wall as a
long flat run, at the speed the drop was worth. Your view and your gravity are
turned with it.

## White Out

The fifth weapon, on `5`. With it in hand the crosshair is replaced by a **small
circle**. Correction fluid for the level:

* **Hold fire and drag.** Everything the circle passes over is painted **solid
  white** — still a wall, still stops bullets — as one smooth line rather than a
  row of dots. While you hold you are **stuck where you stand**; you can only aim.
  The HUD says `PAINTING`.
* **The line is simplified when you let go.** Stamps lying along nearly the same
  curve merge into one (the shape moves by at most ~0.6°), because every stamp
  costs every pixel on screen: a straight drag of 40 stamps becomes two or three.
* **No portal goes on White Out.** A portal ball that would put any part of its
  mouth on white paint or over a hole explodes instead.
* **White Out erases portals.** Paint over a mouth and it goes white with the
  wall; let go and any mouth the stroke took any part of is **gone for good** —
  it does not come back when the hole pops. Its partner stays, with nothing to
  lead to. Decided on the shooter's screen, like the kills.
* **A mark on a moving platform moves with it.** Paint or a hole on a platform
  belongs to that spot of the platform and rides along, instead of hanging in the
  air where it was painted while the platform slides out from under it. A
  platform passing through somebody's hole in the level is not cut by it.
* **Let go** and the whole white stroke becomes a **hole**, all at once. Anybody
  the stroke covered, even an elbow, dies — decided on the shooter's screen, and
  the killfeed says *erased*. Nobody dies while it is still paint.
* The hole is a **real hole**: bullets and portal balls go through it, you fall
  through one in the floor, and you walk through one in a wall. The strokes count
  together, so a slot you dragged top to bottom is a doorway, even though any one
  circle of it is far too small for a body.
* It goes **all the way through**: the circle is a cone out from your eye, about a
  metre across at 20 m and four at 80, so the wall behind the first one has a hole
  in it too.
* A hole stays exactly as it is for **five seconds**, then pops shut. A white rim
  marks its edge.
* The gun recharges for the same five seconds after you let go — the HUD counts it
  down and the circle is dashed until it is ready. One stroke covers about 120
  degrees of drag.

**Out of bounds is death, instantly**: leave the map by more than a metre in any
direction — through a hole in the floor, out of a hole in the outer wall — and you
die on the spot, with *out of bounds* in the killfeed.

## Moving platforms

Four of them in the arena: two lifts and two shuttles. They travel between two
points at a constant speed and turn round at each end, for ever. Stand on one and
it carries you; step off and you keep only what you were doing yourself. A portal
put on one **rides along with it**, mouth and all.

The two lifts are plates you step onto. The two shuttles are **blocks**: 1.3 m
from the floor to the top, which is a whisker under a jump (a jump is worth 1.40
m of rise, and a step is only 0.55), so you have to jump onto one and a jump just
makes it. Solid all the way down, so there is no crawlspace under one to be
caught in — and walking into the side of one is walking into 1.3 m of moving
wall, which shoves you along ahead of it and kills you if there is something
solid behind you. They run the whole length of the room, wall to wall.

A platform only shoves you when it is genuinely running you down: you have to be
on the side it is coming from, and its own path has to be the shorter way out of
you. Brushing a shuttle's long side as you jump past is a bump, not a shove. And
a lift carrying you up into a ceiling crushes you exactly as one coming down on
your head does — a shrinking gap is a shrinking gap.

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

There is no sprint: one walking speed, and hops for anything faster.
Crouching takes 50 ms each way, and stairs are
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

The arena has no stairs: **every slope is a 45-degree ramp**, so a run up never
stutters and a hop chain never catches on the nose of a step.

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

A kill is worth **one magazine** of reserve ammo for the gun in hand — 30 rifle,
6 shotgun, 5 marksman — up to that gun's maximum.

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
  player stood on the box the designer had made;
* standing astride a portal without going through it, and the hand-over itself
  being exact — the eye comes out as far in front of the far mouth as it had
  gone behind the near one, to a millionth of a metre, at the same speed;
* going up through a mouth in a ceiling and out of one on a wall, and then
  accelerating **into that wall** rather than downward;
* a wall-walker reaching a corner and **not** being turned over by it, and the
  same corner walked into the right way up leaving them alone;
* a mouth on a 45-degree ramp, stood in and gone through — and coming out of one
  standing at 45 degrees, where the body still lands, walks where its camera
  looks, and falls the way its feet point;
* the four hand-reported ways a portal used to put a body inside a wall or
  outside the map, each of them red before the fix and green after;
* the single frame of the room that used to flash on the way through a mouth —
  counted rather than looked at: three frames per three crossings before, none
  after;
* a finger that leaves the glass without a release, four different ways, never
  taking the thumbstick or the look pad with it;
* two real pages making a room and joining it: the joiner's own seed discarded,
  the room's level taken, the shield honoured, and leaving and rejoining;
* a lift with a mouth on its underside coming down on somebody, who goes
  through it rather than being crushed — against the same lift with no portal,
  which kills them;
* the portal gun's two touch triggers, including the second tap of a latched
  `AIM` — which used to do nothing at all;
* White Out: holding paints a white stroke that bullets cannot pass while the
  shooter cannot move; letting go turns it into holes a bullet goes through,
  which pop shut at five seconds; a player walks through a slot painted in the
  cover wall that stopped the same walk before; falling out of the map through a
  hole kills on the spot; and a second page's player, painted over behind the
  centre block, lives until the stroke is let go and then dies on their own
  machine.

Frame rate, measured 2026-09-13 in headless Chromium on this laptop's Intel Arc
GPU: 60 fps (the display cap) in the plain arena and still 60 with two portal
views, moving platforms, a White Out hole and a peer on screen, with about 1 ms
of JavaScript per frame. Under a software rasteriser the same busy scene is ~42
fps, and nearly all of that is drawing the portal views, not JavaScript.

## Running the tests

The game itself needs nothing installed. The tests drive it in a real browser:

```sh
npm install && npx playwright install chromium
./serve.sh 8080 &
for t in test/*.mjs; do node "$t" || echo "FAILED: $t"; done
```

There are 28 suites; the table in `claude.md` says what each one covers.
`frame`, `solid`, `portal` and `erase` need no browser and no server, so they run
in about a second each. `rooms` and `whiteout` drive two pages over the real
public relays.

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

`test/frame.mjs`, `test/solid.mjs` and `test/portal.mjs` need neither a browser
nor a server, so they run in about a second each and are worth running first.
`test/frame.mjs` is which way is up: it asserts the movement basis at all
eighteen gravity directions against the closed form the camera has always used,
rather than against itself. `test/portal.mjs` is where the portal arithmetic is proved — that a mouth
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
movement feel and the protection rule — ground control, the
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
src/weapons.js  five weapons and their ammo state
src/erase.js    White Out's holes: the cone, collision and ray masks, the shader patch
src/portal.js   portals as geometry: fitting, traversal, colours (no three.js)
src/portalgun.js the portal gun, the ball, and seeing through a mouth
src/remote.js   remote player rendering, interpolation, hitboxes
src/net.js      Trystero room and the message actions
src/effects.js  tracers, impacts, muzzle flash, viewmodel
src/gunmodel.js the one gun model: the one in your hands, also what others see you hold
src/audio.js    synthesised gunfire, no audio files
src/hud.js      DOM HUD
```

Three.js and Trystero are pulled from jsDelivr via an import map — there is no
build step and nothing to install. If either fails to load, the page says so
instead of sitting black.

## Tuning

* `src/weapons.js` — damage, fire rate, spread, recoil, magazine sizes.
* `src/portal.js` — the size of a portal (`HALF_W`, `HALF_H`); how forgiving
  its mouth is lives in `player.js` (`PORTAL_EDGE`, `PORTAL_CONTACT`).
* `src/portalgun.js` — `MAX_VIEWS` and `VIEW_SCALE`: how many mouths redraw the
  world each frame and at what resolution. Seeing through a portal is by a long
  way the most expensive thing this game does.
* `src/level.js` — `MOVE_SPEED`, how fast every moving platform travels.
* `src/player.js` — movement constants at the top (speed, gravity, jump, step
  height), including the fall gravity multiplier and how much of a fall is paid
  out as speed.
* `src/world.js` — the arena. `add(cx, y, cz, w, h, d, colour)` places a box by
  its centre in x/z and its *bottom* in y; `slope()` builds a 45-degree ramp.
* `src/remote.js` — `INTERP_DELAY` trades smoothness against how far in the
  past other players are drawn.
