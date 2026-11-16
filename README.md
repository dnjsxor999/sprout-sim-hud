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
 Time bar (replay controls or LIVE), the task's progress, outcome, and the event feed
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
* **Re-edits and the watch.** A follow of a moved object is a step (`object moved 3.9 cm → re-edited at phase 0.25`)
  and a teal diamond on the phase bar. A changed decision spliced into the running motion is a step of its own (`watch
  changed the decision → spliced in 0.59 s · elevation 30° → 45° · yaw 0° → 15°`; `LLM changed the decision` for a
  `jev_modify`) and a ring on the phase bar, and the decision card takes its values; the header counts `re-edited ×N`
  (follows) and `spliced ×N` apart. The watch line gives each check's verdict: `decision stands`, `→ spliced in 0.59 s`,
  `change refused (out of reach)`, `budget spent`, `held`, `not applied (the grasp had begun)`. When the engine asks the
  decider itself, the arm may stand until the answer lands: the engine reads `held · asking the decider (object
  moved)`, the watch `resting`, and the step then reads `re-decided in 2.4 s · held 2.8 s → re-edited` (or `→ paused`,
  `→ the decision stands`). A pause names its cause (`Paused: object moved · the LLM decides`), and a hand run's outcome
  ends with its counts (`· 7 re-edits (6 follow · 1 decision) · watch 4 checks, 1 change`).
* The **connectors** carry the messages: a dot travels from the sender to the receiver (intent, menu, the chosen
  motion, the edited motion, success / fail / scene changed, candidates, "kept as ...").
* **A dressed scene** (a paper scene's room set: walls, floor slab, furniture) is drawn around the station but never
  framed: the camera fits the robot, the objects and the station, with the room behind them; the set's walls cast no
  shadow and its floor replaces the page's grid. A scene preset may name its own default view (`web_view: {az, el,
  dist, target}`), which the page opens with and the **default** button returns to.
* **The task's progress** on the time bar: a classic task's four predicates (`in_region`, `at_rest`, `on_surface`,
  `released`; a task with predicates of its own shows those, `grasped`, `lifted`); a paper scene's goals named by what
  they ask (`lifted`, `placed`, `in region`, `clear`) and `hold`, where a goal that counts something is a counter that
  fills as the count grows (`returned 4/10`, `tosses 3/5`, a duration in seconds: `aloft 3.0/60 s`; `0` until the first
  status row). A bundle exported before the scene named its goals shows `goal_0`, ... A replay shows the pills from its
  start. A scene that describes itself (its aids in plain words) shows the text first in **replay notes**, under
  "about this scene".
* **The score** of a scene whose judge keeps a scorecard (the C scenes): a **chip** where the goal pills are gives the
  primary number at the playhead (`balls returned 4/10 balls`, `time to solve –`, `seconds aloft 30.0/60 s`) and, once the
  episode has ended, the card's own number with its verdict (`7/10 balls ✓`; `(unfinished)` for an episode cut off before
  its verdict). Where a goal pill would say the same (a fixed-protocol scene's `passed 0/1`, the aloft counter) the chip
  stands in for it. A click on the chip opens the **Score** block under the Engine block: what the task asks, the protocol
  and the pass rule, the trials decided so far (newest at the bottom; a toss of eight pieces is one line, "toss 3 · 6 of
  8", that opens to its pieces; a click on a line replays from a second before it), and after the end the result: the
  number with its verdict, the pass rule and the card's metrics (units from their names; eight shown, the rest behind
  "more"). Thin marks under the time bar mark the trials (green: went the player's way, red: did not, faint: neither;
  past forty trials only the green and red ones), and the header's scene line names the card's variant (`level L2`). The
  card is the judge's record of the whole episode, so the chip, the block and the marks show nothing the playhead has not
  reached. The episode picker shows each scored bundle's result beside its title (`8/10 balls returned ✓`), except for the
  episode being replayed.
* **The scene's machines** (the conveyor, the maze, the pan toss, the ball launcher, the grip assist, the balloon, the
  banana's swing) say what a viewer cares about in the feed, as World lines (`the target comes round: pass 3`, `pass 3 of
  the target: taken (right hand)`, `toss 3 of 5: 6 turned, 8 of 8 in the pan — 17 points so far`, `ball 4: returned —
  came 0.21 m left of centre, landed 0.62 m past the net`, `the left hand pinches the banana`); a pan toss's shake is a
  faint line, a free swing of the banana none. An item taken, the maze solved, a toss and a returned ball also get a tick
  on the time bar, unless the bundle carries a scorecard, whose own marks stand in for them.
* **Real-time motions** re-plan several times a second: the edited path glides from one re-aim to the next, the Engine
  block counts the run's key moments (`snatch_side_right · launches 1 · captures 1 · lifted`, `cells 12 · solved`,
  `strokes 11`; each also a feed line, `snatch_side_right: capture #1 (right)`), a gaze track that joined the run shows
  on its channel badge (`hand + gaze`) while the card keeps the hands' decision (`gaze → obj:ball_*` under it), JEV's
  watch line gives the lane's own report (`track right: waiting at the ready point, meets it in 4.8 s`; a swinging
  target's in two lines: `track right: the target swings: a period of 2.9 s, 0.30 m to each side; it will stand still at
  its right turn in 1.7 s · meets it in 1.1 s`). While the lane's fit of a swing is settled the view draws the arc it
  predicts for the next period as a faint dotted teal line, and from the launch on the meeting it plans as a small amber
  ring; both go when the fit breaks (the hand holds the thing) or the run ends, the ring just after the planned contact.
  When the hand does not take the target the feed says why in plain words: an abandoned attempt (`gave up the reach —
  the target would ride out of the arm's reach before the jaws close`, `missed the grasp — the jaws closed on nothing`,
  `could not lift it — …`), a pass without one (`no attempt this pass — the target does not stay within the arm's reach
  long enough for a grasp`; the same cause again before the next launch makes no new line), the target out of sight
  (`armed — lost sight of the target, waiting for it to come back`, a quiet line); a text the page does not know reads as the lane
  wrote it. The Engine block keeps the last reason under its phase bar until the next launch (`Last attempt: …`, `Last
  pass: … (3 passes in a row)`), and the watch line's "no meeting: …" is in the same words. The banana brushing a
  waiting hand (C-6) is one quiet line per run; a contact during an attempt is a line each.
  A looping
  run's phase bar shows the phase within the current cycle (`↻42%`). A two-handed motion draws both arms' paths. A pause
  gives the behaviour's own words (`The ball rests in cell B2 and cannot go on to A2 ...`); a `jev_modify` that answers
  it is a step of its own (`LLM changed the route → B2 … A5 (9)`, `LLM changed the decision · pace normal → fast`) and
  the LLM block shows the new bindings and insight. A looping run's periodic report is one quiet line (`progress report
  · strokes 6`), and a run still going at the verdict reads `Ended with the episode · success`; what the runner's
  shutdown leaves after the verdict is not shown.

## Replay a recorded episode locally

```bash
cd web
npm ci && npm run vendor      # the pinned browser libraries into web/vendor/ (MuJoCo WASM 4.0.1, three.js 0.182.0)
npm run serve                 # python3 scripts/serve.py 8788: a static server that sends Cache-Control: no-store, so a
                              # plain reload always fetches the current modules (plain http.server lets the browser keep them)
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

`model.mjb` is the compiled scene with its materials and textures (about 20 MB for a paper scene, most of it the
robot's colour atlas and the scene's skybox), so the page draws the robot's own colours and the pictures on the sign
boards. A bundle exported before the page drew textures still plays: its robot is drawn in a plain grey and its
textured surfaces (the sign boards) blank; export it again to see them.

### What the score reads

| what | where it comes from |
|---|---|
| the chip's label, the task, the protocol, the pass rule | the scene dict's `task.sentence`, `task.protocol`, `task.pass_rule`, `task.primary` (`{key, label, of, unit, better}`): fixed for the episode, there from the start, live too |
| the trials, the result, the metrics | the bundle's `episode.json["score"]`, the judge's card as the run stored it (`primary.value`, `passed`, `final`, `reason`, `metrics`, `trials[]`); a live run gets the same card with the `task/episode_end` row (`extras.score`), after the end only |
| the running number | the `value` of the last trial row whose `t` (sim seconds) the playhead has passed; a card whose rows lack it: the row's field named by `primary.key`, else the task's counter of that key (the status rows' HUD line, read up to the playhead); with none of these, 0 before the first row when the primary has a maximum, else `–` (a live run before its end: the counter or `–`) |
| a line's mark, a tick's colour | the row's `ok` (true / false / null); rows that share one `n` are one line, marked by its rows whose `ok` is true or false: true when at least half of those are true, false otherwise, none when no row says |
| the picker's result | `episodes/index.json` entries' `score` (`{label, value, of, unit, better, passed, final}`), which the exporter and `--reindex` write for a bundle with a card |

A trial's `t` (sim seconds) is placed on the time bar at the first moment the replay reaches that sim time: through the
frames' own sim times when the bundle places its frames on the playback clock (`frames.hz`, every bundle the exporter
writes), else through the rows' (wall, sim) time pairs. A bundle without a card shows
none of this and looks as before.

## Watch a run live

Start the simulator with the web bridge, `sprout-sim run --web` (plus the usual flags). The bridge listens on
`127.0.0.1:8766`: it serves this page at <http://127.0.0.1:8766/>, which follows that simulator at once (the page
finds the bridge's `/api/scene` on its own origin), and streams the run over `ws://127.0.0.1:8766/ws`. A copy of the
page served elsewhere (the GitHub Pages site, `npm run serve`) connects with **Connect** in the header or
`?ws=ws://127.0.0.1:8766/ws`. In a live run you can drag an object on the table: the
simulator moves it, and the page shows how the engine's watch and the LLM react. The engine records its own question
to the decider only when the answer lands, so a live run shows the landed re-decision but not the hold before it (a
replay shows both).

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
| `?score=open\|closed` | the Score block opened or closed at load (otherwise as the visitor left it, closed at first) |
| `?cam=default\|front\|side\|top` | the camera preset at load (`default` is the scene's own view when its preset names one; the buttons work as ever afterwards) |
| `?az=<deg>&el=<deg>&dist=<m>` | any of them: the azimuth and elevation (from the robot's heading, as the presets) and the distance of the camera at load, in place of the preset's and the fitted one |

Keyboard: <kbd>space</kbd> play / pause, <kbd>←</kbd> <kbd>→</kbd> seek 5 s, <kbd>0</kbd> ½× speed, <kbd>1</kbd>
<kbd>2</kbd> <kbd>4</kbd> speed, <kbd>f</kbd> frame the scene, <kbd>t</kbd> theme.

## Tests and captures

```bash
npm test        # the reducer over a recorded episode (tests/fixtures): menu, choice, decision, plan, memory, outcome;
                # re-edits, splices, the watch's verdicts and holds (paper_sweep_4 bundles are checked when present);
                # the paper scenes' task pills and counters, the scene machines' events, real-time motions (re-plans
                # at 5 Hz, key moments, loops) and the plan overlay at 5 Hz; the scorecard (the chip, the Score block's
                # lines, the trial marks, the picker) on synthetic cards and on cards cut from runs (tests/fixtures/scores)
node tests/test_materials.mjs episodes/<id> [...]   # what a bundle's scene is drawn with: every geom's MuJoCo colour,
                # the textures and texture coordinates (the sign boards' pictograms), the scene's object colours
node tests/test_mirror.mjs episodes/<id>/model.mjb   # the MuJoCo mirror: loading, mesh arrays, kinematics, world rows
```

A headless capture of a given moment:

```bash
google-chrome --headless=new --disable-gpu --window-size=1600,1000 --virtual-time-budget=6000 \
  --screenshot=hud.png 'http://127.0.0.1:8788/?episode=<id>&t=60&still=1&debug=1'
```

Under `--virtual-time-budget` the browser renders no frame between a change and the screenshot, so every entry
animation would be caught at its first frame: `?still=1` turns animations off and `?t=` picks the moment. `?cam=side`,
`?el=20` or `?dist=3` pick the view (the camera is framed when the model loads, on the robot's starting heading).

## Recording

**Record** in the header records the page itself: the browser asks what to share. In Chrome the picker opens on its
"Chrome Tab" pane with "This Tab" listed first (older Chrome shows three panes, "Entire Screen / Window / Chrome Tab":
pick the Chrome Tab pane, then this page). Safari and Firefox capture windows and screens only: pick the browser window.
Screen capture exists only on a secure page, so open the page at `http://localhost:8788`, `http://127.0.0.1:8788` or
over https; at a LAN address or a machine name the button says so instead of recording. While it records, the button shows a red dot and the elapsed
time; a click on it (or "Stop sharing" in the browser's bar) stops the recording and downloads it as
`<episode>_<YYYYMMDD-HHMMSS>.webm` (`live_...` in a live run; `.mp4` in a browser that records only MP4). Leaving the
page (the episode picker, a reload) ends the recording too, and its file is then usually lost: stop first. To turn the
WebM into an MP4 for slides or chat:

```bash
ffmpeg -i x.webm -c:v libx264 -pix_fmt yuv420p x.mp4
```

## The folder

```
index.html  styles.css            the page and its look (colour tokens, dark and light)
src/app.js                        boot: the mode from the URL, transport -> reducer -> HUD and viewport, controls
src/model/pipeline.js             the reducer: timeline rows -> the HUD state (pure; a seek re-reduces)
src/transport/live.js replay.js   the WebSocket client and the replay player
src/viewport/                     MuJoCo WASM + three.js: the mirror, the scene's materials and textures, the motion's
                                  path, dragging
src/model/score.js                the scorecard at the playhead: the chip's number, the Score block's lines, the marks
src/hud/panel.js memory.js feed.js the three blocks and their connectors, the memory graph, the bar and feed
src/hud/score.js                  the Score block under the three (the record behind the chip)
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
