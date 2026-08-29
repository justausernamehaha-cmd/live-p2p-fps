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
| `settings.mjs` | rebinding and stacking keys, latchable actions, the 3s protection window, pause overlay |
| `momentum.mjs` | every hop lands and takes off, speed bleeds, a fall is worth speed, a ramp's lip does not rob a chain |
| `slopes.mjs` | ramps are walkable and solid; a turned box collides where it was turned to |
| `solid.mjs` | the convex layer, in node — no browser, no server, about a second |
| `portal.mjs` | portal fitting, sliding, refusal, the traversal map, colour agreement, platform seeds — also node-only |
| `portals.mjs` | the same claims proved to the *player*: walking in, falling through, riding a platform |

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

## Ideas, not built

- **See-through portals.** Traversal was built first and deliberately: it is most
  of what makes them feel right and needs no render target. Looking through one
  would.
- **Peers seeing edits live.** The designer is deliberately single-player: a
  seed is how a level travels. Sharing edits would need an authority for
  conflicts, which this game does not have anywhere else either.
- **Curves.** Ramps and free rotation are built — they became convex solids in
  `src/solid.js`, with axis-aligned boxes keeping their own faster exact path.
  Anything round would need a different representation again, and the convex
  half-space push-out would stop being the right tool.
- **A level browser.** Seeds are pasteable but not discoverable; there is no
  server to list them on.
