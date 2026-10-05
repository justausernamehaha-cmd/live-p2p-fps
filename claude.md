# Live P2P FPS — project notes

Serverless peer-to-peer browser FPS. three.js + Trystero, plain ES modules with
an import map, no build step. Live at
<https://justausernamehaha-cmd.github.io/live-p2p-fps/>, repo
`justausernamehaha-cmd/live-p2p-fps`, GitHub Pages serving `main` at root.

`README.md` documents how it plays and how it is put together. This file is for
things that are not in the code yet.

## Working agreements

- Prove a change works before pushing, and re-run the suite against the deployed
  URL, not only localhost. GitHub Pages sometimes errors silently and sits in
  "building" — poll for the changed file rather than the build status, and force
  a rebuild with `gh api -X POST repos/<owner>/<repo>/pages/builds`.
- A green test that has never been watched go red is not evidence. Reintroduce
  the bug, see the test fail, put the fix back.
- Assert against an independent source of truth: the direction travelled versus
  the camera's own forward vector, the damage taken on the victim's machine.
  "It moved" is a liveness check, not a correctness one.
- End a bug fix with the live link.

## Tests

`npm install && npx playwright install chromium`, then `./serve.sh 8080 &` and
`node test/<name>.mjs`. `GAME_URL` overrides the target so any suite can be run
against the live site.

| suite | covers |
|---|---|
| `movement.mjs` | W/A/S/D go where the camera looks, at nine yaws |
| `mechanics.mjs` | ground control, sprint latch, crouch, stairs, bunny hop, momentum, accuracy, shield |
| `mouselook.mjs` | no single mouse event can swing the view; aiming untouched |
| `mousebuttons.mjs` | every press/release order; stray `buttons` masks |
| `pointerlock.mjs` | no spurious re-locks, no settling spikes |
| `stuckkeys.mjs` | a key release is never discarded |
| `holdtoggle.mjs` | crouch and aim in hold or toggle mode |
| `map.mjs` | every place you can stand lets you stand up |
| `designer.mjs` | the designer builds a level a *second page* can then stand on |
| `settings.mjs` | rebinding and stacking keys, latchable actions, the 3s protection window, pause overlay, the portal gun's two touch triggers |
| `momentum.mjs` | every hop lands and takes off, speed bleeds, a fall is worth speed, a ramp's lip does not rob a chain |
| `slopes.mjs` | ramps are walkable and solid; every slope is 45°; a corner never turns anybody over |
| `frame.mjs` | which way is up: the basis, at all eighteen ups, in node |
| `solid.mjs` | the convex layer, in node — no browser, no server, about a second |
| `portal.mjs` | portal fitting, sliding, refusal, the traversal map, colour agreement, platform seeds — also node-only |
| `portals.mjs` | the same claims proved to the *player*: standing astride a mouth, the hand-over being exact, gravity coming through with the body, riding a platform, no frame drawn from behind a mouth |
| `clipping.mjs` | the four hand-reported ways a portal put a body inside a wall or outside the map |
| `platforms.mjs` | brushing past a platform, standing behind one, and a mouth on the underside of a descending lift (it does *not* cover being carried: with riding disabled it stays green — `portals.mjs` is the one that catches that) |
| `tilted.mjs` | gravity rotated 45°: a body at 45° lands, walks where its camera looks, falls the way its feet point |
| `touch.mjs` | a finger that leaves without a release can never take the controls with it, and a thumb parked on a button never owns the view |
| `rooms.mjs` | two real pages: an empty room is made, an existing one is joined behind a shield, and leaving works |
| `erase.mjs` | White Out in node: paint is solid until opened, holes pop at exactly five seconds, ray masks against dense sampling, and a dragged slot lets a body through where no single circle would |
| `whiteout.mjs` | hold paints white and freezes the shooter, release makes holes, the pop at five seconds, walking through a painted slot, out of bounds is instant death, and a release killing a second page through the centre block |
| `rimfall.mjs` | falling back into the mouth you came out of, drifting toward its rim, goes back through and never out of the map |
| `gunmodel.mjs` | every weapon's gun is the in-hand model, identical in first person and on a body |
| `selfview.mjs` | standing in a mouth you see your far half (on screen and in the mouth's picture) and never the half at your eye; through the other mouth you still see yourself |
| `nearmouth.mjs` | the last few centimetres before a mouth still show what is through it: the screen is compared with the mouth's own picture down to 2 mm |
| `recursion.mjs` | mouths in mouths: a block beside a corridor shows once per trip, each where perspective puts it, through someone else's pair too; each trip is drawn coarser; a mouth behind a slab is not drawn; a 60 m shot down a 6 m corridor is 11 joined legs, drawn, and sent to peers |
| `pull.mjs` | the portal pull setting: off does nothing; inside the reach is drawn through once, outside is not, a body flying away at 40 m/s still is; at 0.5 the reach is the mouth's own size |
| `latejoin.mjs` | two real pages: the second gets the portals placed before it joined and can go through them; the first's colours do not change and the second's are 30 degrees or more away |
| `whiteportal.mjs` | a mouth's border survives facing away from its wall (with a control that puts the bug back), a stroke takes the portal it crosses and tells the peers, and a White Out mark rides the north shuttle — in pixels and in bullets |
| `turnedmouth.mjs` | a mouth turned 45° in its wall: through at its middle, stopped by the wall beside it inside its bounding square |

## Things worth not rediscovering

- **Pushing out of a box to *exactly* touching lets you climb walls.** `_axis()`
  resolves an overlap by moving the player clear of the whole box. Land exactly
  on a face and floating point is free to leave you a fraction inside it; the
  next axis resolved then sees a real overlap and ejects you across the box's
  full height. Walking into a four-metre wall put the player on top of it,
  intermittently — it depended on the last bit of a float. A millimetre of skin
  on every push-out fixes it and costs nothing. This was latent long before
  ramps; the designer just made it easy to build a wall tall enough to notice.
- **Euler angles are not unique.** Two quarter turns about Y come back out of
  `eulerFromMatrix` as `(pi, 0, pi)`, which is the same rotation written
  differently. Never assert on the angles — assert on the footprint they
  produce.
- **A wedge's bounding-box centre lies exactly on its own ramp plane**, so it
  cannot be used to decide which way that face points: the test comes out zero
  and the normal is left pointing inward. The mean of the vertices is strictly
  inside every convex shape and can.
- **A ramp's extents are in its own frame, not the world's.** The wedge is
  defined climbing along its local +x and then turned into place, so a drag has
  to be handed over permuted. Storing the world extents and rotating afterwards
  turned a nine-metre run into a half-metre one nine metres wide.

- **Bunny hopping worked because of a bug, and fixing the bug on its own capped
  it at walking pace.** Ground contact was decided by the last collision
  sub-step; at speed the landing frame reported `onGround` false, which skipped
  the ground rules and preserved the chain's velocity by accident. Deciding
  ground contact per *frame* is correct — it is what made hops reliable and
  friction run at all — but it has to come with an explicit rule that a frame
  ending in a jump keeps its velocity, or the chain is reset to walk speed on
  every landing. Measured: peak 9.92 before, 6.22 after the half fix, 9.94 after
  the whole one.
- **`test/mechanics.mjs` had no assertions for months.** It printed beautiful
  numbers and would have shipped the above in silence. It asserts now; a suite
  that cannot fail is not a suite.

- **A large `backdrop-filter` over the canvas costs a third of the frame rate,
  and keeps costing it after the element is hidden.** Growing `#editpanel` to fit
  the key-binding rows dropped the game from 35 frames per 570 ms to 11, for the
  rest of the session, the moment the panel had been opened once. The panel is
  95% opaque so the blur was invisible anyway — it is gone. The pause overlay
  keeps its blur deliberately (that one is the point) and pays for it with a
  single ~1 s hitch on the way out, measured, not assumed.
- `Level.remove()` refusing `locked` boxes is belt-and-braces: the shell lives in
  `level.shell`, not `level.boxes`, so `remove` could not reach it anyway. Both
  guards had to be broken at once before `designer.mjs` would go red — which is
  the honest reading of "the floor cannot be deleted".
- A test that pokes `player.yaw`/`pitch` and calls `designer._tools()` straight
  after is aiming with **last frame's camera**. The real loop is `_camera()` then
  `_tools()`; a harness has to do the same or every box comes out a thin pillar.

## Key collisions, resolved

The designer reuses keys the match already owns. Nothing actually clashes,
because the two modes never run at once, but the resolutions are worth writing
down:

- `Tab` is the scoreboard in a match and the **playtest toggle** in a design
  room. The scoreboard is suppressed while `game.design` is set, since a design
  room has no peers to score.
- `Q`, `R` and `1`–`3` are last-weapon, reload and weapon select in a match, and
  corner, delete and colour while building. Mode-separated; in playtest they go
  back to being weapon keys, which is what you want when testing a room.
- `Ctrl` is **crouch**. `Alt`+`Ctrl`+click therefore also crouches — harmless,
  because you are a ghost with no crouch while building, and selection is
  ghost-only.
- **`Alt`+click and `Ctrl`+`Alt`+click are grabbed by some Linux window
  managers** (KDE moves the window on `Alt`+drag). If that bites, the fix is in
  the WM, not here — there is no way for a page to see a click the compositor
  ate.
- Releasing the pointer with `Alt` fires `pointerlockchange`, which the game
  reads as `Esc` and answers with the pause menu. Guarded: `onAction('pause')`
  returns early while `design.mouseFree`.
- `` ` `` was **already** the settings panel, which is exactly the panel the key
  rebinding went into, so it stayed. `=` was briefly an alias and has been
  removed at the user's request.
- The designer now has its own bind map entirely (`pa.designbinds`), so none of
  the above is a collision any more — it is just two keyboards for two modes.
  `R` reloads in a match and turns a ramp while building; delete moved to `T` to
  make room for it.

## Portals and moving platforms — built 2026-08-30

Both shipped. What is worth not rediscovering:

- **The erosion loop must read its edges from the original face.** `fitPortal`
  slides a portal to the nearest place it fits by eroding the face polygon by the
  portal's bounding box — offset every edge inward, clip, and whatever survives is
  every legal centre. Reading those edges out of the polygon *as it is being
  clipped* walks a moving target: after the first cut you are offsetting edges the
  erosion itself created and most of the real ones are never applied. It looked
  right and put portals half off surfaces a centimetre too small. `test/portal.mjs`
  catches it two ways.
- **An exact fit is decided by the last bit of a float**, so the fit carries half
  a millimetre of slack. Without it a surface built to precisely a portal's size
  refuses it about half the time.
- **`_axis()` ejects across the whole box when it did not cause the overlap.**
  A portal exit that lands four millimetres inside the floor is not something the
  player walked into, so backing out along the direction of travel is meaningless
  — and the arena floor is 120 m wide, so the eject threw the player out of the
  world. `_unstick()` resolves along the *shallowest* axis instead. Moving
  platforms need the same thing for the same reason: a platform can arrive
  underneath someone.
- **Pushing out along the exit normal alone cannot fix a body inside the floor.**
  That was the first attempt and it silently shoved the player 0.96 m sideways
  (eight passes of 0.12) while leaving them stuck.
- **A portal on the floor is entered by the feet and nothing else**, so the
  crossing samples have to include the feet and the head, not just the middle of
  the body. With the lowest sample at a quarter height, the floor stopped the
  body while the sample was still a foot above the mouth and a floor portal could
  never be entered at all.
- **A 2 m crate is big enough for a portal** (the oval is 1.36 x 1.8). What is too
  small is the *end* of a cover wall — one metre thick. Worth knowing before
  writing a test that assumes otherwise.
- **Colours cannot be derived from the id**, because they have to differ on every
  refresh, and there is no authority to hand them out. Each player announces one
  random number in `hello`; every peer sorts by id, folds the sum into a shared
  rotation, and spreads the first hues over *half* the circle so that a pair
  (h, h+180) can never collide with another player's. Solo is blue and orange
  exactly as asked.
- **Platforms are parked while the designer's ghost is flying.** A box that
  wanders off cannot be aimed at, and the seed stores the start of the run.
- **A platform cannot be in the merged mesh.** `_mesh()` merges everything of one
  colour into a single BufferGeometry; a piece of that cannot walk off on its own,
  so each platform gets its own mesh and its own transform.
- `links()` is cached. Its caller is `_moveStep()`, which at hop speed runs eight
  times a frame — rebuilding the array there allocated ~500 throwaway arrays a
  second to answer a question that only changes when somebody fires.

## The ramp lip, fixed 2026-08-30

Bunny-hopping onto a ramp sometimes stopped you dead, and "sometimes" was the
tell. The step-up in `_moveStep()` was gated on `onGround || vel.y <= 0`. Run up
a ramp and the hop that carries you off the top is still **rising** when your feet
meet the few centimetres of lip where the ramp meets the plate — so no step, and
eighteen metres a second against six centimetres of nothing. Whether it bit
depended on where in the arc you arrived, which is why it felt random.

The gate is gone entirely. It reaches nowhere new: `STEP_HEIGHT` is 0.55 m and a
rising player is already mid-jump with over a metre of climb in hand, so this only
mounts a ledge they were going over anyway instead of scraping up its face, and
there is no ratchet because you cannot jump again in mid-air. An intermediate
version bounded the step by the arc the jump had left; it fixed most of it and
left six cases where the player arrived near the apex with the arc already spent.
Blunt beat nuanced.

`test/momentum.mjs` sweeps 108 approaches (four speeds x three lateral offsets x
three heights x three vertical velocities). It separates a lip from a wall by how
far below the plate's top the body was when it lost its speed: inside
`STEP_HEIGHT` is a fault, a 2.5 m wall is allowed to stop you. Watched go red at
19 of 108 with the gate restored, green at 0 of 108 with it gone.

## Seeing through a portal — built 2026-08-30

Each mouth renders the scene again from a camera put through the portal by the
same transform that moves the player, and the disc samples that texture in
**screen space** — the virtual camera drew the same viewport with the same
projection, so the pixel behind a fragment is the pixel at the same place in the
target. No UVs are involved, which is why it stays correct at every angle.

- **Hide the *exit*, not the entry.** The virtual camera stands behind the far
  mouth looking out of it, so that mouth is right against the lens: leave it in
  and every portal is a picture of the back of its own partner. This was the one
  thing standing between "it renders" and "it works", and it looked like a dark
  blob covering everything.
- **The near plane has to be bent onto the exit's own plane** (Lengyel's oblique
  projection, `obliqueNear()`), or the first thing the virtual camera draws is the
  inside of the wall the exit is on.
- **Portals drawn inside a portal view keep last frame's texture.** One render per
  mouth per frame instead of one per level of recursion, and it is what makes two
  facing mouths a corridor rather than a flat disc. A frame stale, which nobody
  can see.
- **There was no body to see.** This is first-person and the only thing on screen
  was the gun, so `SelfAvatar` in remote.js follows the player and is drawn *only*
  into portal views. Same silhouette as a RemotePlayer, so what you see of
  yourself is what everyone else sees.
- **`Math.sign(0)` is 0, not 1**, which is a degenerate case in the oblique
  construction. It survives it, but it is worth knowing it is there.
- Rationed: only mouths on screen, nearest first, `MAX_VIEWS` of them, at half
  resolution. Measured at 61 fps with two live views against 61 with none, under
  the software rasteriser.

Proved by reading the portal's own render target rather than the screen: paint
the player a colour nothing in the arena wears and count how much of it the front
mouth shows — 934 pixels with the body in portal views, 0 with it taken out.

## Three more things the portals got wrong, fixed the same day

- **A portal used to slide until its border lined up with the block's edge.** It
  now lands exactly where it was shot, overhang and all; the erosion is still
  computed but only to answer "can this surface hold a portal at all", which is
  what decides whether the shot explodes.
- **The ring used to turn.** It is a circle scaled unevenly into an oval, so
  rotating the mesh sweeps that oval around instead of spinning a ring inside it
  — the mouth visibly changed shape, wider than tall and back, once a second.
- **The rim was not an entrance.** The crossing test measured the middle of the
  player against the exact oval, so clipping the edge with a shoulder scraped you
  along it. The mouth is widened by the player's radius now.

## Portals and platforms, second pass — 2026-08-30

Everything below was found by measuring the running game, never by reading.

- **The view through a mouth was linear where sRGB was expected**, so it came out
  at about a third of its brightness — "meshed black". The render target is
  *written* in sRGB (proved: an sRGB target reads back mean 53.4 where a plain one
  reads 10.1) and sampled back as linear, and a raw `ShaderMaterial` gets none of
  the conversions three.js appends to its own materials. `#include
  <colorspace_fragment>` is the whole fix. Proved by putting both mouths in the
  same place facing opposite ways — which makes the portal transform the identity
  — and demanding the disc match the pixels it covers: off by 0.1 of 255.
- **A player pressed against a wall is *behind* the crossing plane.** Collision
  holds them a radius clear of the surface, and the plane the crossing test used
  sat a radius *in front* of it, so walking along a wall into a mouth on that same
  wall slid straight past it. There is now a second way in: touching the surface
  and inside the mouth is enough, whichever way you are walking.
- **Portals ride their platform after the player has already moved**, unless you
  make them do it first. A frame of lag between a lift and the mouth on it sweeps
  that mouth's plane across whoever is near it — which is what "randomly
  teleported" was.
- **A 2 m portal does not fit diagonally on a 2 m crate top.** Floor and ceiling
  mouths took their orientation from the look direction, so whether a box would
  take one depended on where you were standing. Snapped to the face's own axes:
  8 of 8 from every angle.
- **`_axis()` ejects clear of the whole box**, again: a lift rising into the feet
  of someone standing on its edge left them overlapping, and their next step flung
  them to one edge or the other. `_ride()` lifts anyone a platform has come up
  under, before movement, so the overlap never exists.
- **Crushing has to happen before the body moves.** Run it afterwards and the
  overlap is already resolved — by `_axis()` pushing the player up out of the
  platform and standing them on top of it. And past a full crouch the body has to
  keep *compressing*, or the last half a head, the part that kills you, can never
  happen.
- **Lowering the shuttles to make them boardable drove them through the cover
  walls** they used to fly over. Platform routes are swept along their whole run
  against every static box now, in `test/portals.mjs`; eyeballing it got it wrong
  in both directions.
- **A portal must never hang off its wall**, so the slide is back: the erosion
  gives every legal centre and the nearest point of it to the shot is where the
  mouth goes. The earlier "it shouldn't move" turned out to be about the ring
  *spinning*, which is a separate fix and stays.
- **Bullets recurse through mouths** — `rayPortal()` for the geometry,
  `_raycast()` hops up to twice and returns the corners of the path so the tracer
  bends instead of crossing a wall. The exit ray has to be stepped off the exit's
  own plane or it leaves through the face it just arrived at.
- **Standing still in a mouth goes through it**, which forced `EXIT_CLEAR` up from
  0.22 to 0.45: leaving a portal used to land you inside the band that counts as
  standing in one, and you would be pulled straight back.
- **A fixed cooldown between traversals silently capped the infinite fall.** Once
  the drop took less time than the cooldown the crossing was refused, the player
  hit the floor, and the loop began again from rest — speed climbed to about 40
  and reset, for ever. What stops a pair strobing is *which* mouth, not time:
  `exitedVia` refuses only the mouth you just came out of, and only until you are
  a metre clear of it. The cooldown is one frame now, and the loop builds to the
  80 m/s terminal and stays there.
- **`SPEED_CAP` would have thrown that speed away.** A fling out of a wall mouth
  was clamped to walking pace the instant it left. A portal traversal now buys
  three seconds of a raised cap in the air, spent on landing — the ordinary ground
  rules bleed it from there, and nothing else in the game sees a different cap.
- **Measure a fling at the instant of the traversal.** Sampling a moment later
  measures where the flight got to, not what the portal handed over; the old
  "carrying most of the fall as speed" check started failing the moment flinging
  actually worked, because a moment later was a wall away.
- **Ctrl+W cannot be stopped by `preventDefault()`.** Only the Keyboard Lock API
  can, and only in fullscreen — so capturing the mouse takes the page fullscreen
  to earn it. That is a real trade, so it is a checkbox.

## Gravity, a room with a lid, and portals you can stand in — 2026-08-30

Five things asked for together, and they turned out to be one change: a portal
stopped being a teleport, gravity started following the body through it, the room
was closed so there is always something to land on, every corner was filleted so
there is a way back, and the speed limit went.

### A portal is a hole, not a doorway

It used to hand you over at a plane held a player's radius *in front* of the
wall, and put you out a further 0.45 m clear of the far mouth. Both of those were
the teleport showing. Now:

- The wall a mouth is cut into is taken out of collision for exactly as long as a
  body is in that mouth (`Player._boxes`, `_solids`, `World.hostFor`). Nothing
  else changes, and the body can never be more than a radius past the plane
  before the crossing hands it over — so the hole cannot be walked *along*, only
  through.
- The hand-over is **the middle of the body** reaching the surface, and it is the
  portal's own transform applied to the whole body: position, velocity, view, and
  which way is up. It is *anchored* on the eye — that is the thing you are
  looking through, so that is the thing that must not move — and
  `test/portals.mjs` asserts the eye comes out exactly as far in front of the far
  mouth as it had just gone behind the near one, to 1e-6, at exactly the same
  speed. That equality is the whole claim; if it ever drifts, the crossing has
  become a jump again.
- **A crossing is measured against the mouth's own frame, from the last step to
  this one** — not from a guess at where the body is going. Two things forced it.
  A prediction of the body's own step can be short of the real one, so a slow
  approach slips through the gap; and when it is the *mouth* that moves, the
  player's own step says nothing at all. A lift coming down on somebody standing
  still crosses *them*, and the mouth's movement between frames jumps the sign
  without ever being inside a single step. Keeping each mouth's (u, v, d) from
  the previous sub-step makes all of it one test. `_through` no longer advances
  the body first — it has already passed the plane, which is what was measured.
- **The first two portals of a session are the expensive ones**: their render
  targets are built on the frame they appear, and that frame can be long enough
  that a fixed stopwatch in a test ends with the player still short of a mouth
  they were always going to walk into. It failed once against the live site and
  never locally. Wait for the traversal, not for a clock. (A mouth with no
  previous sample now also steps *backwards* to make one, so a crossing is caught
  in the sub-step it happens in rather than the one after.)
- **A mouth in a moving platform is a way out of being crushed by it.** `_ride`
  and `_crush` skip the platform whose mouth the body is in (`_carvedMover`), so
  a lift with a portal on its underside comes down and takes you through instead
  of squashing you. `straddling` is therefore recomputed at the top of `update`,
  before the platform code runs, and not only inside the collision sub-steps.
- **The trigger was the eye at first, and that broke every mouth on a slope.**
  On a vertical wall the head and the middle stand at the same distance from the
  plane, so it made no difference and looked right. On a 45-degree face they are
  0.64 m apart: a mouth on the arena's own ramp sits about 1.3 m above the floor,
  asking the *eye* to get below its plane means sinking a whole eye-height into
  the hill, and the floor underneath stops you at about half of that. You could
  stand in the mouth, see the far side through it, and nothing would happen.
  Half of you through is the rule.
- Which means you can stand still with the body astride a mouth, half out of each
  — the thing that was asked for. The other half is drawn as a *ghost* out of the
  far mouth (`ghostOf` in remote.js, for peers and for your own body in portal
  views). There is no clipping to do: each half is behind the surface its own
  mouth is cut into, so the walls do it.
- **The carve has to be predictive.** A body arriving faster than the reach is
  wide gets stopped by the wall on the sub-step *before* the hole opens, stands
  on it for a frame, and sets off again from rest — a fall arrived at 18 m/s and
  left at 8. `_findStraddle` grows the reach by however far this sub-step will
  close on the surface.
- **Anchor the hand-over on the eye, not the feet.** Where a mouth lies on a ramp
  the transform turns the body by something that is not a right angle, and
  rounding the new up to an axis moves whatever point was pinned — 0.7 m at the
  head, for a mouth on the arena's own stairs. Pin the eye and the error goes
  into where the feet hang, which nobody is looking through.
- Gone with the teleport: `EXIT_CLEAR` on arrival, `PORTAL_LEAD`, `exitedVia`,
  `PORTAL_REARM` and the cooldown. Nothing stops a pair strobing because nothing
  needs to: a hand-over requires an actual crossing, and it leaves you in *front*
  of the far plane, so the next one needs another one.
- Deliberately lost with it: sliding along a wall past a mouth no longer drags
  you through. Touching the surface anywhere inside the oval used to be enough.
  You have to go in now, which is the same rule that stops it being a teleport.

### Which way is up is per player (`src/frame.js`)

Up is one of the six world axes, and gravity pulls along -up. That keeps every
collision AABB axis-aligned however the body is standing, so the step-up, the
platform code and the whole of `_axis` work unchanged — they are only told which
letter is up and which way it points. At the ordinary up the arithmetic is
*identical* to what it was, and `test/frame.mjs` asserts the basis against the
closed form the camera has always used rather than against itself.

A portal turns you over by applying its transform to your up and rounding to the
nearest axis. So the user's own case — a mouth over your head, another on a wall
— comes out standing on that wall with gravity pulling into it. A portal on a
ramp rounds, which is blunt on purpose: half a frame of a tilted body is worth
less than every other surface in the game staying exact.

The camera rolls into a new up over 0.22 s (`upBlend`), because the body turns at
once and physics has no use for a half-turned frame, but a view that snaps 90
degrees is unreadable.

### The room has a lid, and every corner is filleted

The arena is a closed 12 m box (it was 9 m of wall and open sky; 9 put the
ceiling within a jump of somebody standing on the centre block). The designer's
rooms always had a ceiling.

Every inside corner, floor and ceiling alike, carries a 45-degree wedge — in the
arena (`World._fillets`) and in every designed room (`Level._buildFillets`,
derived from the room's size and never encoded, so old seeds still describe
exactly this room). They are not decoration: for somebody standing on a wall a
right-angled corner is a dead end, because there is no surface between the wall
and the floor that either of them can walk on. A 45-degree face belongs to both.

They started out as a gravity switch too — a walkable 45-degree face handed you
to whichever axis it could equally belong to, but only ever toward upright, so a
fillet carried a wall-walker back down. **That is gone at the user's asking.**
Only a portal ever changes which way you fall: touching a slope is not consent to
be turned over, and getting home from a wall is meant to cost you a shot and a
walk. What the fillets are for now is that they are the only walkable surface
between a wall and a floor at all — for somebody standing on a wall the corner
would otherwise be a sheer face — and that a mouth goes on one perfectly well.

Every slope in the default map is 45 degrees now, the centre stairs included.

### No speed limit

`SPEED_CAP` (22 m/s) and the raised `PORTAL_SPEED_CAP`/`portalFling` that existed
only to get out of its way are both gone. Friction, drag and the collapse on a
bump are the only things that take speed off you now.

### The portal gun's two triggers, on a phone

With it in hand the FIRE and AIM buttons become LEFT PORTAL and RIGHT PORTAL and
wear the pair this page actually agreed with everyone else. **A latched AIM had
to be suspended while they do** (`Input.setHoldOverride`): a toggled aim placed a
mouth on the tap that turned it on and nothing at all on the tap that turned it
off, so every second tap was dead. Watched go red.

## A wall with a hole in it — 2026-08-31

The four items above are done, and about twenty-five more arrived alongside
them. The one idea worth keeping is this: **a portal is a hole in a wall, and
collision has to be given a wall with a hole in it.**

It used to be given no wall at all — the whole box was taken out of the box list
for as long as a body was in the mouth. A wall that is entirely absent is not a
wall with a hole in it, and that one shortcut was four separate ways out of the
map, all four reported by hand and all four now in `test/clipping.mjs`, red
before and green after:

* stand in a mouth and walk toward the edge of it. You leave the oval while
  still inside the wall, the wall comes back, and `_axis()` pushes you clear of
  the *whole box* — the length of the room;
* stand **on** a wall (a portal turned you over) with a mouth on that same wall.
  Gravity is into the wall, it switched off as soon as your feet were near the
  oval, and you sank through it and out of the room without reaching the hole;
* stand on the far side of the wall the mouth is on, right behind it, and walk
  in. A portal is a hole in *one side* of a wall;
* and a mouth that turns you over standing you inside the exit's wall with
  nothing to push you out, because the wall was not there to push.

`pierce()` in `portal.js` cuts the oval out in eight horizontal bands, so the
hole is the shape of the mouth rather than the square it is inscribed in — a
square hole is passable at its corners, where the picture plainly says wall.
Each band is cut to the widest the oval gets anywhere within it, so the hole is
never *narrower* than the mouth: whatever fits through the picture fits through
the collision. `u` and `v` are world axes on any axis-aligned face (see
`frameFor`), which is the whole reason bands of axis-aligned boxes can describe
an oval at all.

Around it:

* **`_axis()` can only correct a move by as much as the move was.** Anything
  deeper is an overlap the move did not cause, and pushing clear of the whole box
  then throws the body out the far side. Give the move back and leave it to
  `_unstick()`.
* **`_unstick()` picks the shortest way out that actually *is* out.** It used to
  take the shallowest axis of whichever box, blind — and the shallowest way out
  of one box is very often straight into the next, which on the following pass is
  shallowest back the way it came. A body across the foot of a wall sat there
  being shoved back and forth for as long as it lived.
* **Entry is from the front only.** A mouth is entered while some part of the
  body is at the front of it; once you are in, you stay in, because a body wholly
  behind the surface is the ordinary case one step later. Without the first half,
  standing behind a wall opened it.
* **The failsafe watches all three axes**, one metre outside the level for a
  quarter of a second, and puts you on a spawn point. It used to be `pos.y < -20`,
  which only catches falling down the world's own y — and gravity follows a body
  through a mouth, so somebody who gets out leaves *sideways*. It only ever
  fetches back a body that was inside to begin with, so a test parking a player
  forty metres up is left alone.

## The camera is the thing the player is — 2026-08-31

Asked for in those words. Three consequences, all of them real:

* **The crossing is judged on the eye as well as the middle**, whichever reaches
  the far side of the surface first. A mouth on a ceiling — the underside of a
  rising lift — is entered head first, and asking the middle of the body to get
  there means half of you is inside the platform before anything happens. Taking
  whichever comes first can only ever hand you over earlier, never later; the
  middle stays because a mouth lying on a slope needs it.
* **The crossing is asked again when the step ends.** Asked only at the top of a
  step, the test compares the end of the *last* frame with the end of this one, so
  a step that ended past the surface was handed over a frame late — and that
  frame was drawn with the camera already behind the mouth, where the disc is
  behind the lens and the wall is backface-culled. One frame of the room beyond.
  That is the flash on the way through, and `test/portals.mjs` counts it: three
  frames per three crossings before, none after.
* **The near plane came in from 50 mm to 15 mm.** A body standing in a mouth is
  astride the surface, and at the rim its eye can be a centimetre from the wall
  beside the hole — at 50 mm that wall was clipped away and you could see straight
  through it.

The camera also builds its own basis now instead of using `lookAt`, because
`lookAt` takes its roll from an up vector it cannot use once the look direction
is parallel to it — which is why the pitch used to stop a hundredth of a radian
short of straight up and straight down.

## Gravity that rotates 45 degrees — 2026-08-31

There are eighteen ups: the six world axes, and the twelve that sit at 45° between
two of them. `snapUp()` rounds a portal's image of your up to the nearest of the
eighteen. (A six-way `snapAxis()` used to sit beside it; nothing called it, and it
went in the 2026-09-13 simplification.)

The six keep the fast path **exactly** as it was. That is the whole design:

* the body's box is axis-aligned however it is standing, so collision resolves
  one world axis at a time, exactly and cheaply;
* the movement arithmetic is bit-identical, because it is written against two
  flat *directions* (`flatBasis`) which for an axis up are precisely the two world
  axes it always used, as unit vectors, in the same order.

A tilted body is not an AABB in any world frame, so `_moveTilted()` collides it
as the capsule it has always been to the ramps — against the level's boxes too,
expressed as convex solids on demand by `boxAsSolid()`. `axisKey()` returning
null is the whole test for "is this body tilted".

Given up honestly, and only when tilted: the stair step-up, and being carried or
crushed by a moving platform. All three are written in terms of which letter is
up, and a tilted body has no letter — it is on 45° ground, where there are no
stairs. `_move()` already sub-steps finely enough that nothing tunnels.

## Rooms are found, not created — 2026-08-31

There is no server, so "does this room already exist" cannot be asked; it can
only be listened for. CONNECT opens the room and waits:

* nobody there and it is yours — your code, your seed;
* somebody there and the room already has a level. The seed box is discarded, the
  room's own seed is asked for over a new pair of messages (`sq`/`sr`), and you
  arrive behind a three-second shield with the gun locked for the same three.

The scan's clock runs from when the room was **opened**, not from when CONNECT
was pressed: the pre-join usually opened it while the name was still being typed.
Every test therefore waits for `game.running` rather than for a fixed number of
milliseconds — that change alone broke half the suite when the scan went in.

## A parked thumb is not aiming — 2026-09-01

Reported: *"on mobile, if I first hold a button, I can't drag my view with
another finger."* Exactly true, and the cause is one comparison.

Every action button doubles as a look pad, because on a phone the thumb on FIRE
is the same thumb that aims. So a finger that lands on a button is added to
`_touch` with the role `look`, like a finger on the canvas. `_lookTouch()` then
picked the owner of the view as the **earliest finger to land** — first-wins, so
that pressing JUMP mid-drag could not snatch the view away from the thumb already
turning it.

The thumb holding FIRE lands first and never moves. It owned the view for as long
as the button was held, and the other finger's drags were dutifully followed —
`lookMove` keeps every look finger's position up to date so a hand-over does not
jump the view — and then thrown away. Nothing turned.

Landing order was the wrong order. What matters is the order fingers **began to
aim**: a look finger only becomes a candidate once it has travelled more than
`TOUCH_DRAG_SLOP` (5 px) from where it landed, and it is ranked by when it
crossed that, not by when it arrived. A thumb resting on a button is never a
candidate; a thumb that starts to drag from a button still is; and a second
finger pressing a button mid-drag still cannot steal the view, because it has not
started aiming and the finger already turning has the earlier drag order.

Crossing the slop rewinds the finger's reference point to where it landed, so the
travel already made is paid out rather than lost — there is no dead zone, only a
deferred one. Measured: the second finger's 120 px drag turns the view 0.504 rad,
to the digit the same as a plain canvas drag and the same as the button thumb's
own drag.

`test/touch.mjs` grew a fifth case, watched go red first (`otherFingerTurns: 0`,
then `0.504`), which also asserts the button stays held through the other
finger's drag and that the button's own finger can still aim.

## White Out — 2026-09-10

Asked for in one line: *"when holding that gun, it shows a small circle instead of
crosshair, and when clicked, it erases everything in that circle, including
players, which will die. it recovers slowly and finishes after 10s."*

* **The circle is a cone.** Its apex is the shooter's eye and its half-angle is
  the angle the ring subtends (`ERASE_ANGLE`, about 3 degrees — 1 m across at
  20 m, 4 m at 80). "Everything in that circle" taken literally is everything
  behind it too, so it is a hole all the way through, not a dent in the first
  wall. It is also the only version with the same shape on every screen: a hole
  that stopped at the first surface would need peers to agree what that was.
* **The level is never edited.** A hole is subtracted from it wherever it is
  asked about — collision (`Player._touches`), hitscan (`World.raycast`), portal
  balls (`World.pick(..., true)`) and the shader (`eraseMaterial`). Healing is the
  cone narrowing, so there is nothing to rebuild or put back.
* **Collision is exact for boxes**: a wall is solid to a body only where their
  overlap is not inside the cone, and a cone is convex, so that is eight corners.
  A body walks through a hole in a wall only when the hole is wider than the
  body — from about 18 m away for someone standing. Ramps are asked with their
  bounding box, which errs toward solid near a hole.
* **It heals by area, not by radius.** tan(half-angle) goes as the square root of
  the time left, so the hole's area shrinks evenly to nothing at ten seconds.
* **The recharge has to be its own clock.** `Loadout.nextShot` is shared by every
  gun, and ten seconds there locked the rifle out the moment you switched to it.
  `readyAt` lives on the weapon's own state.
* **Who dies is decided by the shooter**, against peers where the shooter's screen
  draws them (`Erasures.touchesBody`, any part of the body), and sent as an
  ordinary hit of 200 flagged `er` — so the victim's shield still works and the
  killfeed says *erased* on every screen.
* The `er` message carries the direction at four decimals: two would put the far
  end of the cone half a metre off at sixty metres.
* **Deliberately not done** (portals: changed 2026-10-01, a stroke takes them
  now): portals are not erased (a mouth over a hole floats
  in the air and still works); a hole is not sent to somebody who joins while one
  is open; and **falling out of the map through a hole is not a death** — the
  failsafe puts you on a spawn point, as it always has. That last one is the one
  most likely to be wanted differently.

## White Out, second version — 2026-09-13

Reported after trying it: *"i should be able to hold and drag to make it all
white … before my mouse is released, it stays all white but im stuck and cant
move"*, *"i should be able to pass through the hole"*, *"make it stay there for 5
seconds then pops out"*, and *"people who is out of bounds should be instantly
dead"*. Read as, and built as:

* **Hold = paint, release = hole.** Holding fire stamps the circle along the aim
  every `STAMP_STEP` (0.75 of the ring's half-angle), filling in when the mouse
  jumps. A stamp is the same cone as before, but white paint and solid until
  `Erasures.open(owner, stroke)`. The shader draws paint white and discards holes.
  Network: `er` is one stamp, `eo` opens a stroke.
* **The shooter is frozen from the frame fire goes down**, not the frame the
  stroke starts — `_fire` runs after movement, and the first version walked one
  frame (0.104 m, caught by the test). Flat velocity is zeroed and the player is
  updated with `IDLE_INPUT`; gravity and aiming still work.
* Anything that ends the hold ends the stroke: letting go, dying, a menu taking
  the controls (IDLE_INPUT), switching weapon. Kills are judged at release, against
  every stamp of the stroke.
* **Passing through needed the holes to count together.** The old box test was
  exact but one cone at a time, and a single circle is 0.42 m across at 4 m —
  nobody standing ever fitted. `clearsBox` now samples the overlap (the middle of
  each thin axis, every 0.3 m along a long one) against the union of holes. That
  is deliberately forgiving: a body fits any hole its middle line fits.
* **Five seconds, full size, then gone.** No shrinking. Recharge is the same five
  seconds from the release.
* **Smooth line** (asked for next): a stamp is a *swept* cone, from the stroke's
  previous stamp's aim to its own — a capsule in angle — so the edge is straight
  where circles every `STAMP_STEP` left a notch 7% of the radius deep. The point
  test, collision and the shader use the sweep exactly; ray masks use plain cones
  a quarter of a radius apart along it (44 of 240,000 samples differ, all on the
  edge). Three vec4 arrays per stamp now, so the limits are 40 a stroke and 48 in
  the world — WebGL2 only guarantees 224 fragment uniform vectors.
* **No portal on White Out** (asked for next): `Erasures.coversOval` samples the
  mouth's centre, a half-size ring and its rim against paint and holes, and the
  ball explodes if any is covered. A portal already there when somebody paints
  over it stays (until 2026-10-01: the stroke takes it at release).
* **Instant out-of-bounds death exposed an old `_unstick` bug.** With no clear
  way out it takes the cheapest move anyway; a body left under the centre block
  (the settings suite does this) has ramps on all four sides and the block above,
  so the cheapest was down, and the next pass went down again, out through the
  floor. The failsafe used to teleport that away silently. Candidates that would
  leave the level's bounds are now dropped whenever any other remains. Found by
  instrumenting `walks` in settings.mjs: `out of bounds ▸ set`, escapes 1.
* **Out of bounds is death**, shield or not (`Player.outOfBounds`, killer id
  `#bounds`), replacing the quarter-second teleport. `escapes` still counts it,
  which is what `clipping.mjs` and `tilted.mjs` assert is zero. A portal exit
  with nowhere to put you is also out of bounds now.
* Two bugs the node suite caught on the first run: `open()` did not mark the
  uniforms stale, so `holes` stayed 0; and `Array.from`'s map callback has no
  third argument.

## Simplified — 2026-09-13

Asked for as "as simple as possible while still functioning properly". Every
feature stayed; the source went from 9,481 lines to 7,652. What changed:

* **Comments cut to the why.** The essays that were in the code are this file's
  sections above; the code keeps one or two lines where it would otherwise look
  wrong (SKIN, the `_axis` cap, the camera basis, never filtering keyup).
* **Duplication folded into one place:** `Avatar` in remote.js is the body, the
  far-mouth half, the label and the pose for both a peer and your own portal
  body; `Player._pushOut` is the ramp push-out shared by the upright and tilted
  paths, `_overFootprint` the test `_ride` and `_crush` both made;
  `World._solidMesh` builds merged and platform meshes alike and `rayAABB` is
  `aabbSpan` with the far end dropped; `Game._dropNet` / `_openRoom` /
  `_relayError` replace four copies of the room-opening code; `level.js` uses
  `util.hash`, which was the same FNV-1a as its private `fnv`.
* **Dead code removed:** `World.moverUnder`, `Input.lookEnd`, `Level.resize` /
  `inside` / `all`, `snapAxis`, `lookAngles`, `overlapsPartner`, the portal
  disc's unused `uTint`, `Layout.onSelect`, and a dozen exports only used inside
  their own file. `test/portal.mjs` checks the view turn with `anglesIn(UP_Y, …)`,
  which is the same formula `lookAngles` was.

Checked by diffing every file with comments and whitespace stripped, so each
code change was reviewed on its own, and by the full suite.

**`touch.mjs` had a clock flake, in the old code as well as the new** (the old
build failed it 1 run in 5, measured). "The finger on the button can still drag
the view" read the yaw 60 ms after the drag; under the software rasteriser a
frame sometimes stalls through the whole drag, so the turn was still sitting in
`lookDX` — exactly 0.504, applied a moment later — when it was read. It now waits
two animation frames instead of a clock. 5/5 after.

## Performance, measured — 2026-09-13

Benchmark: headless Chromium, 900x600, 8 s per scene, rAF frame count plus wall
time wrapped around the game's own functions and a CDP CPU profile. "Busy" is two
mouths on screen, the four platforms running, a White Out hole re-opened every 4 s
and a peer walking in front of a mouth.

* **Headless Chromium can use the real GPU here**: `--use-gl=angle
  --use-angle=gl --enable-gpu --ignore-gpu-blocklist` reports the Intel Arc
  (Meteor Lake). The test suites use SwiftShader; for frame rate, use the GPU.
* Real GPU: plain 60 fps, busy 60 fps (the cap), JavaScript ~1 ms per frame.
  There is nothing to optimise on this machine.
* SwiftShader: plain 60, busy ~42, JavaScript 2.4 ms of a ~24 ms frame with the
  main thread 88% idle — the cost is rasterising the portal views, not JS. The
  simplification changed none of these numbers (original 41.6, simplified 41.9).
* **The touch buttons' `backdrop-filter: blur(2px)` cost ~17%** under SwiftShader
  (plain 59.5 -> 49.6, busy 41.3 -> 34) — ten blurs recomposited over the canvas
  every frame, on exactly the devices with the weakest GPUs. Removed, with the
  fullscreen button's. The pause menu keeps its blur on purpose.
* Seen and left alone: with a portal view on screen three.js re-derives program
  parameters for every material on every pass (`getParameters` ~0.5 ms/frame under
  SwiftShader), because a render target's output colour space differs from the
  canvas's. It is inside three.js and costs nothing visible on a real GPU.

## Seven asks — 2026-09-28

* **Alt+Tab is the desktop's again.** `keyboard.lock()` with no argument locks
  *every* key, Alt+Tab included. It now takes `LOCK_CODES` (input.js): letters,
  digits, F-keys and the rest, without Tab, Alt or Meta. Cost: Ctrl+Tab is the
  browser's again. settings.mjs spies on the call and fails if Tab/Alt/Meta are in
  it or W is not. **That was not enough on KDE Wayland**: Chrome's lock took every
  desktop shortcut regardless, and Alt+Tab opened the scoreboard. Now Alt down
  unlocks outright (`_releaseForAlt`), Tab with Alt held is ignored, Alt up
  re-locks if still fullscreen + pointer-locked + focused; blur clears it.
* **Shift does nothing.** Sprint has no default key (SPRINT touch button and a
  bindable row remain). `_loadBinds` drops a saved Shift->sprint once
  (`pa.binds.noshift`), and now accepts every BINDABLE action, not only defaulted
  ones — otherwise a key the player gave sprint was thrown away on reload.
* **White Out strokes are simplified on release** (`simplify()` in erase.js):
  Douglas-Peucker on the aim path on the sphere, tolerance ERASE_ANGLE*0.2, merged
  sweeps capped at 1 rad and halved (not split at the noisiest point) when only
  too long. It runs inside `open()`, deterministic, so every peer ends with the
  same holes. The shader gets the half-angle directly (no per-pixel `atan`).
  erase.mjs checks the line moves by <= the tolerance against its own brute-force
  arc distance; loosening the tolerance tenfold turns it red.
* **One gun model** (`src/gunmodel.js`): the gun you see in your OWN hands, used
  for the body others see too (first try went the other way — wrong). Per-weapon
  barrel and accent live in `weapons.js` `gun`; the portal gun's accent wears the
  owner's pair on everyone's screen. gunmodel.mjs compares the two mesh by mesh.
* **You no longer see yourself in the mouth you stand in.** The picture in that
  mouth is from your own eye carried through, so your body out of the far mouth
  is first person there. `renderViews` hides `selfView` for `p === selfMouth`
  (SelfAvatar's `mouth`, from the same `ghostOf` that places the ghost). Through
  the *other* mouth you still see yourself. selfview.mjs reads the portal's render
  target back and counts pixels of a body painted magenta.
* **A portal that will not fit upright lies on its side** (`fitPortal` tries the
  quarter turn). Only quarter turns: on an axis-aligned face u and v must stay
  world axes or `pierce()` cannot cut the hole and takes the whole wall out.
  (Any angle since 2026-10-01; `pierce()` learned to cut a turned oval.)
* **"Out of bounds going through portals" — the hole is wider than the oval.**
  `pierce()` pads the hole by PORTAL_CONTACT (0.20) and the body is 0.17 wide, so
  a centre can sit 3 cm outside the oval while in the hole. Jump into a ceiling
  mouth whose partner is in the floor, come out head first too slowly, drift
  sideways and fall back: the eye crossed the surface at v = 1.03, the crossing
  test said "wall, not hole", and the body sank out of the bottom of the map.
  A body standing in a mouth now counts any crossing of its surface. Found by a
  probe firing the real portal ball at random surfaces and throwing the player
  through with random keys (9 deaths in 250, 0 after); `rimfall.mjs` fails on the
  old code. Every out-of-bounds death now logs `oobWhy` (which check, position,
  velocity, up, crouch) to the console — look there first if it is reported again.

## Five asks — 2026-10-01

* **The border of a portal vanished when you faced away from its wall.** The
  ring sits 8 mm further out from the wall than the disc and both are
  transparent, so three.js sorts them back to front by depth. Facing the wall
  the ring is the nearer and is drawn last. Face *away* from the wall with the
  mouth still at the edge of the view and "8 mm further out" is 8 mm further
  from the camera: the ring went first and the opaque disc painted over it. The
  ring has `renderOrder = 1` now. `whiteportal.mjs` counts ring pixels (9,691)
  and then puts the ring back in the depth sort as a control (267). My first
  guess — the mouth's centre behind the camera — was wrong, and the control
  said so: three.js sorts on clip-space z without the divide, so nothing flips
  there. Looking exactly along the wall is a tie, broken by creation order,
  which is why it only showed past that angle.
* **White Out erases portals.** At release the shooter asks every mouth whether
  this stroke's holes took any of its oval (`Erasures.holesOval`, a 5 cm grid,
  finer than the thinnest stroke) and removes those for good; the list rides on
  the `eo` message as `kp: [[owner, side]]` so no two screens disagree. While it
  is still paint the mouth is only whitened: the disc and ring materials are
  patched with `eraseMaterial` like the walls (the disc's raw shader got the
  `#include`s the patch looks for).
* **A mark on a platform moves with it.** The level has one `Erasures`; now
  every platform has its own too (`movers[i].erase`), holding the same stamps
  measured **from that platform's centre at the moment each was painted**. The
  level's meshes, collision and rays answer only to the level's; a platform's
  only to its own (`World.eraseOf`, `erasedOverlap`, `erasedBox`, `_rayMasks`;
  `uEraseShift` in the shader is the platform's centre now). So a mark is a
  place on the platform, and a platform crossing a hole in the level is not cut
  by it. Every stamp goes into every platform's list whether or not it touches
  it — in the platform's frame a cone that misses it always will, and it keeps
  the sweep from the previous stamp intact. A stroke painted while the platform
  moves has a different apex per stamp in that frame, so `simplify()` leaves it
  alone there.
* **Platforms are not in step between peers** (each page runs its own from when
  it loaded — true before today, and of portals on platforms too). So `er`
  carries `mv`, the shooter's platform centres, and the receiver places the
  platform's copy of the stamp from those: the mark is on the same part of the
  platform on every screen, wherever that screen's platform happens to be.
* **Not done:** holding the circle still on a moving platform paints one dot,
  which rides off; it does not smear a line along the platform as it slides
  under the circle. A stamp is only made when the aim turns.
* **A portal turns to whatever angle fits** (`fitPortal`): upright, then a
  quarter turn, then every 5° and every edge-aligned angle outward from upright,
  least turn first, nearer centre on a tie. The erosion uses the oval's own
  reach toward each edge (`hypot(HALF_W nx, HALF_H ny)`), not its bounding box —
  identical on an axis-aligned face, and the only thing that lets a turned oval
  fit at all. `pierce()` cuts a turned oval too: the bands still run along a
  world axis, each as wide as the turned ellipse gets inside it (shape matrix,
  chord centre `q Suv/Svv`, half-width `sqrt((Suu - Suv²/Svv)(1 - q²/Svv))`, and
  the extreme points when a band contains them). The axis-aligned path is
  untouched arithmetic. `overlapsMouth` compares differently-turned coplanar
  mouths rim against rim. Portal axes go over the wire at four decimals now.
  A mouth turned by an odd angle turns the body by it, and the new up is rounded
  to one of the eighteen as it always was for a mouth on a ramp.
* **Alt+Tab, third try — still unconfirmed on the real desktop.** Hardened, not
  proven: Alt down now calls `keyboard.unlock()` *whatever* `keyboardLocked`
  says (that flag is set by promises: two lock requests from one click reject
  and resolve in either order, and a stale `false` meant Alt released nothing);
  a rejected `lock()` no longer clears the flag; a lock landing while Alt is
  held is handed straight back; a click with Alt held does not re-lock. F3 has
  an `alt` line (`let go of the lock Nx`) — if this is reported again, read that
  first: 0 means the page never saw Alt, a count means Chrome was told to let go
  and did not. Headless cannot press a compositor shortcut.
* `gunmodel.mjs` switched weapons past `_paintGun`; it goes through `_switch`
  now, as a player does. `portals.mjs` "a platform shoves you before it crushes
  you" failed once in three runs at exactly its threshold (0.05, polled on a
  16 ms clock) — a sampling flake, not chased.

## Things that were reported and are not obvious

* **A phone that goes to the home screen with a thumb down delivers no
  release.** The thumbstick and the look pad were singleton slots claimed by
  pointerId and freed only by an event carrying that same id, so one missed
  release owned the slot forever: the stick froze at whatever it last read and
  walked the player into a wall, and no later finger could take it. Every touch
  now lives in one map with four ways of being dropped, the last of which
  reconciles against `TouchEvent.touches` — the browser's own count of fingers on
  the glass, which is authoritative and free.
* **A virtual keyboard shrinks `visualViewport`, and that is not a smaller
  screen.** Believing it shrank the menu to 300 px while the canvas stayed fixed
  to the whole viewport, so tapping the room field put the default arena on screen
  under the panel. The last height measured with nothing focused is kept until the
  field is let go of.
* **Turning a wedge over is a half turn about the direction it *runs*.** It was
  done about the world's y, and the rotations are applied X then Y then Z — so an
  `rz` of π lands after the aiming turn and mirrors world x as well as y, which
  reversed exactly the two ceiling fillets that run along x.
* **A moving platform only shoves you when you are in its path.** It used to put
  you against whichever face its *velocity* pointed at, wherever you stood: jump
  beside a shuttle, clip its long side by a centimetre, and it put you four metres
  down the thing every frame. Now it needs you on the side it is coming from *and*
  its own path to be the shorter way out of you.
* **Disposing a body walks its meshes rather than naming them.** The gun became
  several meshes and `dispose()` still said `this.gun.geometry.dispose()`, which
  threw halfway through and left LEAVE THE ROOM half done with the HUD still up.

## Still open

* **Shooting the portal you are standing in away.** The improved `_unstick()`
  should push you out the short way rather than putting you on top of the wall,
  and the failsafe backstops it, but there is no test for it yet.
* **A mouth on a ramp is still carved whole.** A convex solid cannot be pierced
  the way a box can — what is left of a wedge around a hole is not convex — so a
  ramp carrying a mouth is taken out of collision entirely, gated on the middle of
  the body being genuinely over the oval. A push-out cannot fling anyone the
  length of a wall the way `_axis()` could, which is why that gate is the whole of
  the fix that side needs, but it is not a hole.

## Ideas, not built

- **Peers seeing edits live.** The designer is deliberately single-player: a
  seed is how a level travels. Sharing edits would need an authority for
  conflicts, which this game does not have anywhere else either. (Joining a room
  now takes the room's seed, which is a different thing: it is asked for once, on
  the way in.)
- **Curves.** Ramps and free rotation are built — they became convex solids in
  `src/solid.js`, with axis-aligned boxes keeping their own faster exact path.
  Anything round would need a different representation again, and the convex
  half-space push-out would stop being the right tool.
- **A level browser.** Seeds are pasteable but not discoverable; there is no
  server to list them on.

## Thrown out of the floor — 2026-10-03

* **Coming out of a floor mouth head first could throw you 1.6 m up onto the
  floor.** After a hand-over `_findStraddle` asked whether the exit had been
  "entered from in front" (`_nearFront`), which wants a body sample between
  0.17 behind the surface and 0.20 in front. The samples are 0.41-0.45 m apart,
  so an eye 6-20 cm past the surface left none in that window: not in the
  mouth, no hole in the floor, and `_unstick` lifted the whole body out. Falling
  back in from there went middle first and put the eye above the lid for a few
  frames. How far the eye overshoots depends on the frame times, which is why
  `rimfall.mjs` was "flaky on a busy machine". `_through` now sets `_inMouth`
  to the exit itself. Same overshoot before and after: thrown out 5 of 8, then
  0 of 8.
* **Running the suites cool.** `taskset -c 8-10` (three efficiency cores) keeps
  the package at 76-80 C where the full machine goes past 90. Freezing a suite
  with SIGSTOP to cool it breaks every wall-clock check; do not. On three cores
  the fixed stopwatches in `portals.mjs` (the walk onto the lift mouth) and
  `holdtoggle.mjs` (the aim ease) were too short, and both wait for the event
  now. `slopes.mjs` needs five cores (`8-12`, 81 C); `settings.mjs` and
  `clipping.mjs` each failed once in three runs on three cores.

## A leaning body falls into White Out too — 2026-10-03

* `_touches` asked whether the hole covered the overlap of the wall with the
  body's *box*. At 45 degrees that box is 1.6 m wide around a 0.34 m body, and no
  hole ever covered it, so a leaning player stood on erased floor. Tilted, it now
  asks a radius-sized box at each stretch of the capsule. The check in
  `whiteout.mjs` bores the hole from 8 m (0.4 m across at the feet): from 30 m
  the hole is wide enough to cover the box and the old code passed.

## A wedge between each pair of walls — 2026-10-03

* The default arena has four more fillets: the same 1.6 m wedge stood on end in
  each vertical corner (`_fillets`: a quarter turn about x, then about y so the
  square corner is the room's). `map.mjs` asks a ray from the middle of the room
  toward each corner: 84.15 m to the bare corner, 83.01 m to the wedge.
  Designer rooms still have only the eight floor and ceiling fillets.
* **A side effect of the floor-mouth fix, seen in `clipping.mjs`:** jump into a
  low ceiling mouth whose partner is on a wall and you no longer end up standing
  on that wall. That only ever happened because the exit threw the body out of
  its hole; now the body stays in the hole, a jump has too little in it to climb
  out, and you fall back through and go round again (5 crossings in 2.4 s). The
  check reads gravity at the hand-over now. Whether that loop is wanted is the
  user's call.

## Crouching takes 50 ms each way — 2026-10-05

* `CROUCH_TIME` is 0.05 s, both ways (it was 0.3). `mechanics.mjs` times the
  descent and the rise in frames and now asserts on them; the old crouch block
  only printed.

## You see your far half — 2026-10-05

* Standing in a mouth, the half of you at the *eye* is never drawn and the half
  far from it always is. Your own view used to draw no body at all, so your
  legs hanging out of a far mouth you could plainly see were missing; and the
  picture in your own mouth hid both halves, so looking back at yourself through
  it showed nobody. `renderViews` now takes `selfBody` and `selfGhost`
  separately: own view = ghost only, your own mouth's view = body only, every
  other view = both. `selfview.mjs` paints the two halves different colours and
  reads each view back.

## The last 4 cm of a crossing showed the wall — 2026-10-05

* **Reported as "I look stuck in the wall, then teleported".** The mouth's mesh
  sits 2 cm proud of its wall and the disc 4 mm more; the camera's near plane is
  1.5 cm. So an eye within about 4 cm of the surface had the disc clipped away
  and saw bare wall until the hand-over at 0. At a run that is under a frame;
  walking in slowly or stopping half way it is the whole screen. Old, not new:
  the pushed build does it too. Found by pinning the body at 15, 6, 4 and 3 cm
  and screenshotting, then a raycast from the lens (disc at 0.016, wall at 0.04).
* `PortalField._fitNear(camera)`: for a mouth the eye is within 10 cm of (and
  roughly in front of), disc and ring are drawn 6 cm *behind* the wall with no
  depth test, grown about the eye's foot by `(d + 0.06) / d` so the outline on
  screen is unchanged. Reset at the top of `renderViews` (portal views must see
  every mouth on its wall), applied after it. It also covers the other side:
  just after the hand-over the eye is between the exit's disc and its wall.
* `nearmouth.mjs`: the mouth's render target has the screen's viewport and
  projection, so where the mouth covers the screen the two must be the same
  picture. 0 difference from 15 cm to 2 mm with the fix; 16-30 of 255 at 3 cm
  and under without it.
* **`ghostOf` gave a body to anyone standing behind a mouth's wall.** `atMouth`
  is two-sided to a whole body height, so within 2 m behind the surface counted
  as "in the mouth" — invisible on a thick wall, a second body out of the far
  mouth on the 1 m cover walls (for peers too). `mouthAround` now asks
  `throughMouth`: across the surface, or within reach of it.

## A mouth seen in itself is drawn again — 2026-10-05

* Asked for: "if I can see A through B it should loop". A mouth seen in its own
  view used to sample last frame's picture at the same place on screen, which is
  a feedback loop and not what is there. `_chain` now carries the camera through
  the portal once per level (M, M², ...) and `_views` draws deepest first. Only
  a mouth's *own* chain recurses (in the view through A the exit B is hidden, so
  the mouth you can see in it is A again); any other pair's mouth in a view
  still shows last frame's picture.
* **Limits:** `MAX_DEPTH` 6 trips, `MAX_RENDERS` 10 views a frame over every
  mouth (each later mouth keeps its one), and a chain stops when the next mouth
  in is not in the frustum, not seen from the front, or under `MIN_NESTED` (4%)
  of the screen's height. Mouths that do not face each other cost one view, as
  before.
* **Two targets per recursing mouth**, alternating by level, because a picture
  cannot be sampled while it is drawn into. Level 1 always lands in `p.target`,
  which is what the screen and the suites read.
* **The deepest level shows its mouth dark, not stale.** A stale picture there is
  a fixed point: whatever was once in the middle of it is sampled back at the
  same pixels for ever. portals.mjs caught it (24 px of a body that had been
  taken out of the views half a second before).
* Measured on the Arc GPU at 1846x1223: 60 fps with no portals, 60 with a 3 m
  corridor (6 views a frame), 60 at 8 m (4 views).

## Views in views, for everyone's portals — 2026-10-05 (later the same day)

Supersedes the `_chain` paragraph above: there is no `_chain` and no `target2`.

* **`_view` is a tree, not a chain.** To draw what is through `p` it first asks
  `_seen` which mouths that picture will show — `p` again, its owner's other
  pairs, anyone's — and draws each from the camera carried on through it, into a
  pooled target, before drawing itself. A mouth it has no view for shows dark
  (a stale picture there is the fixed point described above).
* **Only what shows is drawn.** `_rect` is the box round a mouth on screen;
  a view in a view gets the box of its mouth cut to its parent's box, the target
  is scissored to it, and under 2% of the screen it is not drawn. `_inSight`
  tries nine lines from the mouth back to the eye (to the exit's surface for a
  view in a view) against `World.raycast`; all blocked, not drawn. Not asked for
  a mouth the eye is within 0.5 m of.
* **Each trip in is 0.84 as sharp as the last** (`DEPTH_SCALE`; half resolution,
  then 0.42, 0.35, ...). The pool is per depth.
* **`selfview.mjs` lost its control.** It counted the body anywhere in the other
  mouth's picture; with a scissor that is 0, correctly — two mouths side by side
  on one wall never show you yourself (the line would have to cross the oval 3 m
  outside it). The 307 px it used to find were in a part of the picture no mouth
  showed. portals.mjs's facing pair covers "you are drawn through a mouth".
* **The border is flat.** It was additive, so its colour was the wall's plus its
  own: one colour on a wall, another in a view, another in a view of that.
* **Shots.** `SHOT_PORTALS` 2 -> 16 (range ends it sooner), the mouth test gets
  1 mm past the wall hit (same surface, two computations), `net.shot` carries
  every leg in `p` (older clients ignore it) and `_remoteShot` draws them, and
  the tracer pool is 192 so a shotgun's legs do not overwrite each other.
* Arc GPU, 1846x1223: 60 fps with no portals, a 3 m corridor (6 views), and a
  corridor through someone else's pair (9 views).
* portals.mjs "but still does with the rifle" failed once (aim eased to exactly
  0.5 after a fixed 400 ms on three cores) and passed on the rerun.

## Portal pull, late joiners, and colours that stay — 2026-10-05 (evening)

* **Portal pull** (settings slider `#pullslider`, 0 to 1, default 0 = off, saved
  as `pa.pull`, lives on `player.suck`). Each mouth has an egg in front of it:
  half-axes `HALF_W * 2x` across, `HALF_H * 2x` up, and `HALF_W * 2x` out (the
  user's "the ellipse revolves about the centre", read as the oval turned about
  its long axis). `Player._pullStep` runs before all other movement: the body's
  middle coming INTO an egg is flown straight to the mouth's centre at
  max(own speed, 14 m/s) with no collision, keys or gravity, then handed over by
  `_through` and sent out at max(own speed, a walk). Edge-triggered
  (`_pullIn`), and `_through` marks the exit as already-inside, or the exit's
  own egg takes you straight back for ever.
* **Late joiners never got existing portals** — `pt` is only sent when a mouth
  is placed. `_peerJoin` now sends your pair to the newcomer alone. This is the
  likely source of "players should be able to see other players' portals".
* **Colours are announced, not dealt.** `assignHues` (every join re-dealt the
  whole room) is gone. Each player owns `portals.myHue` and says it in the
  hello (`ph`, with `pj` = Date.now() when they started PLAYING — a player on
  the menu announces none). `_settleHue`: if my pair is within `hueRoom(n)`
  (30 degrees, or 90/n in a crowd) of someone who started earlier, I pick the
  middle of the widest gap and say so. Only ever my own. Seniority is by each
  machine's own clock, so a badly wrong clock can make the wrong one give way.
  Builds from before this ignore `ph` and will disagree on colours until
  everyone has reloaded.
* **settings.mjs could not be verified today.** On three cores it failed three
  runs on three different timing checks, and the PUSHED build's own copy failed
  the same way ("the game stopped rendering while paused") served side by side,
  so it is the machine, not the change; five cores hit the 85 C kill. Its
  `walks` helper now counts frames instead of milliseconds. Rerun it cool.
