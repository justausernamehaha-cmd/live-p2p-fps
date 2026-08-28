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

---

# Idea, not built yet: level designer

Asked for 2026-08-28. Recorded to build later — **nothing of this exists in the
code**.

## Getting in

Type `level design` as the room code on the connect screen. That drops you into
a design mode instead of a match.

Before starting, choose the room's **width, length and height**. You cannot
leave that box once inside.

## Moving

You are a ghost.

- `W` `A` `S` `D` move forward, left, back, right.
- Movement follows where you are looking, so **look up and go forward to rise**.
- `Alt` releases the mouse, so you can point at things precisely.

## Drawing a rectangle on a surface

Only rectangles (rectangular boxes) are supported.

1. Tap a starting point. The program works out **which surface that point is on**.
2. The second point is **constrained to that same surface** — if the cursor
   leaves it, the point stays on the surface rather than jumping elsewhere.
3. **Left click** fixes the rectangle's base.
4. **Move the mouse to pull a height**, and the box is finished.

## Drawing a floating box

For something not attached to a surface:

1. Go to where one corner should be and press `Q`.
2. Go to where the opposite corner should be and press `E`.
3. The box is finished.

## Selecting and editing

- **`Alt` + `Ctrl` + click** an object to select it. The floor, walls and ceiling
  are selectable too.
- `1` … `0` set the selected object's colour (ten colours).
- `R` deletes the selected object. **The floor, walls and ceiling cannot be
  deleted.**

## Questions to settle before building this

Recorded so they get asked rather than guessed at:

- Does the ghost collide with anything, or pass through placed boxes?
- Is the height step in 3 pulled along the surface normal, and can it go
  negative to sink a box into the surface?
- For the `Q`/`E` floating box, are the corners the player's position, or the
  point being looked at? Position is the literal reading.
- Which ten colours, and does `0` mean the tenth or a reset to default?
- Is a level saved, and where — `localStorage`, an export string, or shared with
  peers so others can play it?
- Does the designer stay single-player, or do peers in the same room see edits?
- Should the arena in `world.js` become loadable data so a designed level can
  replace it? It is currently hand-written boxes in `_build()`.
