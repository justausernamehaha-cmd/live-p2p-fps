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
| `slopes.mjs` | ramps are walkable and solid; every slope is 45°; a corner fillet turns a wall-walker upright |
| `frame.mjs` | which way is up: the basis, at all six ups, in node |
| `solid.mjs` | the convex layer, in node — no browser, no server, about a second |
| `portal.mjs` | portal fitting, sliding, refusal, the traversal map, colour agreement, platform seeds — also node-only |
| `portals.mjs` | the same claims proved to the *player*: standing astride a mouth, the hand-over being exact, gravity coming through with the body, riding a platform |

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

## Ideas, not built

- **Peers seeing edits live.** The designer is deliberately single-player: a
  seed is how a level travels. Sharing edits would need an authority for
  conflicts, which this game does not have anywhere else either.
- **Curves.** Ramps and free rotation are built — they became convex solids in
  `src/solid.js`, with axis-aligned boxes keeping their own faster exact path.
  Anything round would need a different representation again, and the convex
  half-space push-out would stop being the right tool.
- **A level browser.** Seeds are pasteable but not discoverable; there is no
  server to list them on.
