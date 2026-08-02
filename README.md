# Operation Vanguard

A Call of Duty–style multiplayer FPS that runs entirely in a browser tab.

**[▶ Play it](https://blhsing.github.io/operation-vanguard/)** — no download, no plugin, no install.

---

## What it is

A complete arena shooter: six three-lane maps, a 36-weapon arsenal with
attachments, create-a-class, perks, killstreaks, ranked progression, and bots
that have to actually see you before they can shoot you.

The maps are Crossfire (village crossroads), Refinery (industrial), Shipment
Yard (tiny, relentless), Highrise (two towers and an open roof), Dust Market
(a bazaar at noon) and Subway (an underground station with no sky at all).

Plus **Zombies** — round-based co-op survival with a points economy, wall buys,
the Mystery Box, Pack-a-Punch, perk machines, and a down-and-revive loop.

And a six-mission **Campaign**, one mission per map, with a squad that follows
you, scripted objectives, and checkpoints that re-enact the fight you lost rather
than restoring a snapshot of it. A mission is a dependency graph of objectives
declared as data and interpreted by one runtime — the same shape as the objective
engine that drives the five competitive modes.

The interface is in **Traditional Chinese** (zh-Hant-TW), using system CJK fonts
so the zero-binary-assets rule survives localisation.

It ships **zero binary assets**. Every texture, weapon model, character, sound
effect and map is generated from code at runtime. The entire game — geometry,
audio, art — is about 220 kB gzipped.

## The interesting parts

**One simulation, no renderer.** `GameSimulation` is transport-agnostic and has
no dependency on three.js, so it runs headless in Node — which is how the test
suite plays entire matches and entire campaign missions with nothing attached to
the screen.

That is also what makes a dedicated server a bounded piece of work rather than a
rewrite, and it is worth being precise about what exists: **there is no server
and no networking today.** There is no `src/server/`, `ws` is an unused
dependency, and the `NET` constants in `constants.ts` — protocol version, port,
interest radius, input batching — are a design nobody has implemented yet. Every
mode in the menu is fully playable and populated entirely by bots.

**Presentation is downstream and one-directional.**

```
input ──▶ simulation ──▶ events ──┬──▶ renderer
               │                  ├──▶ audio
               └──▶ world state ──┴──▶ HUD
```

Nothing on the right ever writes to the left. That is why the test suite can run
whole matches — bots, ballistics, collision, mode rules — with no renderer
attached, and catch "everything compiles and nothing happens".

**Maps are code, not data files.** A map is convex brushes plus semantic
annotations, authored in TypeScript from a shared prop kit whose dimensions are
derived from the movement constants. A 1.0 m crate is mantleable because
`MANTLE.maxHeight` says so, not because it looked about right. `validateMap()`
builds a real collision world and runs real queries against it, which is how it
caught three spawn clusters embedded in a wall on the first map.

**Bots lose like people.** Difficulty changes reaction time, aim error, turn
speed and target leading — never damage. A Recruit and a Veteran fire the same
guns for the same damage. Aim error is a slowly-drifting bias rather than
per-tick noise, because white noise averages out over a burst and makes bots
uncannily accurate at sustained fire; a persistent offset reproduces the human
pattern of missing one way and then correcting.

**Zombies reuses everything.** A zombie is an ordinary player entity on
`Team.Hostile`, driven through the same `InputCommand` a human sends. It collides,
gets shot with the same per-bone hitboxes, takes wallbang and explosion damage,
and paths on the same nav graph. There is no separate zombie movement code to
keep in sync — which also means a zombie can never walk through a door you
cannot. The one thing it does differently is always know where you are, because
a horde you can hide from is not a horde.

**Balance is enforced, not asserted.** `validateArsenal()` computes real
time-to-kill for every weapon at every range and fails the build if an assault
rifle strays outside 250–420 ms at 20 m, if an SMG doesn't fall off past 25 m, or
if anything at all can body-shot faster than 150 ms. It caught five genuine
balance breaks while the arsenal was being written.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

### Running it with no server at all


```bash
npm run build:standalone
```

Produces an ordinary folder you open straight off the disk in Chrome — no web
server, no install, no network:

```
dist-standalone/
  index.html      1 kB
  vanguard.css   18 kB
  vanguard.js   901 kB
```

One rule of `file://` decides the shape of this. A **module** script is fetched
with CORS semantics, and a `file://` page has an origin of `null`, which fails —
so `<script type="module" src="…">` never loads. A **classic** script tag is not
fetched that way and works fine, as do stylesheets and images. So the bundle is
built as an IIFE and the build strips `type="module"` and `crossorigin` from the
tag Vite emits.

Two consequences worth knowing. Rollup cannot code-split a classic bundle, which
is why there is one `.js` rather than a vendor chunk beside it. And a classic
script in `<head>` is *not* deferred the way a module script is, so the build adds
`defer` — without it the app queries the DOM before `<body>` has been parsed, and
everything looks right in the markup while nothing works.

Any real asset added later lands in the same folder (or inlined as a data URI
under 4 kB) and loads fine; today there are none, because every texture, sound,
model and map is generated from code.

The build then *refuses to emit* a folder that would not run off the disk: a
surviving module script or `crossorigin`, an absolute path, a referenced file
that was not written, a top-level `import`/`export`, an undeferred head script,
or a bundle that no longer parses. A build that works over http and shows a blank
page off the disk is very easy to produce by accident, and the only way never to
ship one is to make the build fail instead.

`npm run verify:standalone` then drives the real thing in real Chrome from a
`file://` URL over the DevTools protocol: it starts a match through the menu,
checks the canvas has a live WebGL context and the HUD is counting ammo, and
screenshots the result. It observes from the outside on purpose — an earlier
version reached for a development-only debug handle that does not exist in the
artefact people actually run.

```bash
npm test          # headless match simulation + balance + collision + weapon tests
npm run typecheck # strict, zero errors
npm run build     # production bundle
```

## Controls

| | |
|---|---|
| Move | `W` `A` `S` `D` |
| Sprint / tactical sprint | `Shift` / tap `Shift` twice |
| Jump, mantle, vault | `Space` |
| Crouch / slide | `Ctrl` (while sprinting to slide) |
| Prone | `Z` |
| Fire / aim | Left mouse / right mouse |
| Reload | `R` |
| Melee | `V` |
| Swap weapon | `1` `2` |
| Lethal / tactical | `G` / `Q` |
| Killstreaks | `3` `4` `5` |
| Buy / interact (Zombies) | `F` |
| Scoreboard | `Tab` (hold) |

A gamepad is detected automatically and uses the standard layout.

## Layout

```
src/shared/     the simulation — no three.js, runs in Node and the browser
  math/         allocation-free vector and angle maths
  collision/    exact convex-brush collision over a spatial hash
  sim/          movement, weapons, combat, spawns, the tick loop
  data/         weapons, attachments, perks, killstreaks, equipment, modes
  map/          brush format, prop kit, maps, validation
  ai/           navigation graph and bot behaviour
  zombies/      round curve, horde director, economy, per-map layouts
  campaign/     mission data model, objective graph runtime, six missions
src/client/     everything that presents it
  scene/        renderer, viewmodel rig, entity rendering
  render/       procedural textures, materials, models, map geometry
  audio/        procedural Web Audio synthesis
  hud/          HUD and minimap
tests/          headless match, movement, weapon and data-integrity tests
```

## Design notes

A few decisions that are load-bearing and non-obvious:

- **Firing is gated by a timestamp, not a countdown.** A countdown quantises
  rate of fire to the tick rate and makes a 900 RPM gun and an 850 RPM gun behave
  identically.
- **Ground detection cannot use "is my vertical velocity positive?"** Walking up
  a ramp produces upward velocity, and a sprinted slope walk exceeds jump
  velocity, so the two are not separable by magnitude. An explicit post-jump
  lockout is the only honest discriminator.
- **Respawn delay is flat.** An earlier version escalated it with consecutive
  deaths as an anti-spawn-trap measure, which had it backwards: it punished the
  player being trapped. Spawn-trapping is the influence map's problem.
- **Nav graph edges are short.** Long edges must survive every intermediate
  walkability probe, so raising the connection radius *reduces* connectivity —
  one clipped doorframe twenty metres away kills the whole link.
- **The zombie round curve caps speed but not health.** An uncapped speed curve
  does not make the game progressively harder, it picks one round to become
  unplayable and is identical before that.
- **Events are handed over at the end of a tick, not cleared at the start.**
  Clearing first silently discarded anything emitted *between* ticks, so a mode
  calling `damagePlayer` directly lost every event it caused.

## Licence

MIT.
