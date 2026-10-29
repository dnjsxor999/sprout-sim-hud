# The pipeline HUD (`web/`)

A static web page that shows the motion-based agentic control pipeline while it works, next to a 3-D mirror of the
MuJoCo simulation: the LLM plans with a memory of motions, JEV decides and edits each motion to the scene, the engine
runs the motion and watches it, and the motion memory grows with every success that is kept. The page replays recorded
episodes and follows a running simulator live; both deliver the same records, so they look the same. The design and
the record formats are described in [docs/design/WEB_HUD.md](../docs/design/WEB_HUD.md).

## What the page shows

```
 World (3-D mirror, draggable objects)  │  LLM · Planner            looks, thinks, chooses a motion + insight
                                        │  JEV · Decide, Edit & Watch  the menu, the decision chain, refusals, the edit, the watch
                                        │  Engine · Execute            the running motion, its phase, the outcome
 Motion memory: hand · gaze · base · root (a kept success hangs under the motion it came from)
 Time bar (replay controls or LIVE), task predicates, outcome, and the event feed
```

* **LLM · Planner** lights up while the model perceives, thinks (with the seconds), asks for a menu or chooses. It shows
  the last image it looked at (with the objects it detected), its last words, and its choice: the motion, what it is
  bound to and the one-line insight.
* **JEV · Decide, Edit & Watch** shows the menu while it is built (every candidate decided for the current scene), which
  motions fit, the one the LLM chose, the decision (grasp face, pinch, pad height, elevation, yaw, lift, speed, each
  with the decider's confidence), a refusal with its reason, and the edit (the motion as authored, dashed, and as
  edited to the scene).
* **Engine · Execute** shows the running motion, its channel and the robot's control mode, the phase, a pause when
  the scene changed, and the outcome. The watch belongs to JEV: while a motion runs, JEV's block shows that it watches
  every tick (`watching every tick · check 7 · p 0.02 · carry on`), and its steps list keeps the chain of decisions,
  re-decisions, edits and refusals of the current command, revealed one step at a time so a burst can be followed.
* The **connectors** carry the messages: a dot travels from the sender to the receiver (intent, menu, the chosen
  motion, the edited motion, success / fail / scene changed, candidates, "kept as ...").

## Replay a recorded episode locally

```bash
cd web
npm ci && npm run vendor      # the pinned browser libraries into web/vendor/ (MuJoCo WASM 3.14.0, three.js 0.182.0)
npm run serve                 # python3 -m http.server 8788
```

Open <http://127.0.0.1:8788/>: the first episode of `episodes/index.json` plays. The MuJoCo WASM version must equal the
Python `mujoco` version (the scene is loaded as a binary `.mjb`); `npm run vendor` refuses any other.

## Add an episode

```bash
.venv/bin/python tools/web/export_episode.py logs/sweeps/<sweep>/<run> --out web/episodes/<id>
.venv/bin/python tools/web/export_episode.py logs/sweeps/<sweep>/<run> --out web/episodes/<group>/<id>   # grouped
.venv/bin/python tools/web/export_episode.py --reindex web/episodes                   # the index alone
```

The exporter writes `episodes/<id>/{episode.json, frames.bin, model.mjb}` from a run folder (the timeline, the
player's transcript and the episode log) and adds the episode to `episodes/index.json`, which feeds the picker in the
header. Bundles may sit one level down in group folders (`episodes/basic_tasks/<id>`): the index lists them as
`<group>/<id>` and the picker shows each group under its own heading. The page reads `episodes/index.json` only, so
bundles copied in by hand need `--reindex web/episodes`.

## Watch a run live

Start the simulator with the web bridge, `sprout-sim run --web` (plus the usual flags). The bridge listens on
`127.0.0.1:8766`: it serves this page at <http://127.0.0.1:8766/>, which follows that simulator at once (the page
finds the bridge's `/api/scene` on its own origin), and streams the run over `ws://127.0.0.1:8766/ws`. A copy of the
page served elsewhere (the GitHub Pages site, `npm run serve`) connects with **Connect** in the header or
`?ws=ws://127.0.0.1:8766/ws`. In a live run you can drag an object on the table: the
simulator moves it, and the page shows how the engine's watch and the LLM react.

## URL parameters

| parameter | effect |
|---|---|
| `?episode=<id>` | replay `episodes/<id>/episode.json` |
| `?ws=<url>` | follow a running simulator |
| `?t=<seconds>` | start a replay at that moment |
| `?speed=0.5\|1\|2\|4` | replay speed (½× lets a burst of JEV's decisions be followed) |
| `?autoplay=0` | start a replay paused |
| `?theme=light\|dark` | the theme (otherwise the system's, or the last choice made with the toggle) |
| `?debug=1` | show errors, rejected promises, console errors and a page wider than the window in a panel |
| `?still=1` | no animations (for headless captures, see below) |

Keyboard: <kbd>space</kbd> play / pause, <kbd>←</kbd> <kbd>→</kbd> seek 5 s, <kbd>0</kbd> ½× speed, <kbd>1</kbd>
<kbd>2</kbd> <kbd>4</kbd> speed, <kbd>f</kbd> frame the scene, <kbd>t</kbd> theme.

## Tests and captures

```bash
npm test        # the reducer over a recorded episode (tests/fixtures): menu, choice, decision, plan, memory, outcome
```

A headless capture of a given moment:

```bash
google-chrome --headless=new --disable-gpu --window-size=1600,1000 --virtual-time-budget=6000 \
  --screenshot=hud.png 'http://127.0.0.1:8788/?episode=<id>&t=60&still=1&debug=1'
```

Under `--virtual-time-budget` the browser renders no frame between a change and the screenshot, so every entry
animation would be caught at its first frame: `?still=1` turns animations off and `?t=` picks the moment.

## The folder

```
index.html  styles.css            the page and its look (colour tokens, dark and light)
src/app.js                        boot: the mode from the URL, transport -> reducer -> HUD and viewport, controls
src/model/pipeline.js             the reducer: timeline rows -> the HUD state (pure; a seek re-reduces)
src/transport/live.js replay.js   the WebSocket client and the replay player
src/viewport/                     MuJoCo WASM + three.js: the mirror, the motion's path, dragging
src/hud/panel.js memory.js feed.js the three blocks and their connectors, the memory graph, the bar and feed
src/util/                         formatting, colours, easing, DOM helpers
episodes/                         replay bundles and index.json
tests/                            node tests and the recorded fixture
scripts/vendor.mjs                copies the browser libraries from node_modules into vendor/
```

## GitHub Pages

`.github/workflows/pages.yml` publishes `web/` when a push to `main` touches it: `npm ci`, `npm run vendor`,
`npm test`, then the upload and deploy steps of GitHub Pages. The live mode of the published page connects to a
simulator on the visitor's own machine; browsers treat the loopback address as a secure origin, so the HTTPS page may
open `ws://127.0.0.1`.
