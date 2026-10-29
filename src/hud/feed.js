// The bottom bar (docs/design/WEB_HUD.md sections 8.1 and 8.5): the replay controls (play / pause, speed, a scrubber
// with the episode's event ticks coloured by actor, the time), or a LIVE indicator with the elapsed time; the task's
// predicates and outcome; and the event feed, the page's full record and its only scrolling element.

import { h, s, setText, setAttr, setClass, setHidden } from '../util/dom.js';
import { fmtClock, fmtClockTenths, num, clamp } from '../util/format.js';
import { actorVar, ACTOR_LABEL } from '../util/colors.js';
import { SPEEDS } from '../transport/replay.js';

const PREDICATES = ['in_region', 'at_rest', 'on_surface', 'released'];
const STICK_PX = 8;   // the feed follows new lines while the viewer is this close to its bottom
// the speed buttons' faces and keys: half speed is "½×" on the key 0 (there is no "½" key), the others their digit
const SPEED_FACE = { 0.5: '½×' };
const SPEED_KEY = { 0.5: '0' };

const ICON_PLAY = 'M7 4.5v11l9-5.5z';
const ICON_PAUSE = 'M6 4.5h3v11H6zM11 4.5h3v11h-3z';

/**
 * `root`: the bar element. `handlers`: `onToggle()`, `onSeek(t_rel)`, `onSpeed(n)`.
 */
export function createFeed(root, handlers = {}) {
  const playIcon = s('path', { d: ICON_PLAY });
  const play = h('button', { class: 'play', type: 'button', 'aria-label': 'Play', title: 'Play / pause (space)' },
    s('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' }, playIcon));
  const speeds = h('div', { class: 'speeds', role: 'group', 'aria-label': 'Playback speed' },
    ...SPEEDS.map((n) => {
      const face = SPEED_FACE[n] ?? `${n}×`;
      return h('button', { type: 'button', 'data-speed': String(n), title: `${face} speed (${SPEED_KEY[n] ?? n})`,
        'aria-label': `${n} times speed` }, face);
    }));
  const ticks = s('svg', { class: 'ticks', viewBox: '0 0 1000 14', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const played = h('div', { class: 'played' });
  const knob = h('div', { class: 'knob' });
  const tip = h('div', { class: 'tip mono', hidden: true });
  const scrub = h('div', { class: 'scrub', role: 'slider', tabindex: '0', 'aria-label': 'Episode time', 'aria-valuemin': '0' },
    ticks, h('div', { class: 'track' }, played), knob, tip);
  const liveInd = h('div', { class: 'live-ind', hidden: true },
    h('span', { class: 'live-dot', 'aria-hidden': 'true' }), h('span', { class: 'mono' }, 'LIVE'), h('span', { class: 'live-t mono' }));
  const time = h('span', { class: 'time mono' }, '0:00 / 0:00');
  const preds = h('div', { class: 'preds', 'aria-label': 'Task predicates' },
    ...PREDICATES.map((p) => h('span', { class: 'pred mono', 'data-pred': p, title: `${p}: false` }, p)));
  const outcome = h('span', { class: 'pill outcome mono', hidden: true });
  const list = h('ol', { class: 'feed', 'aria-label': 'Event feed' });
  const empty = h('li', { class: 'feed-empty' }, 'No events yet.');
  list.append(empty);
  const jump = h('button', { class: 'feed-jump mono', type: 'button', hidden: true }, '↓ latest');
  root.replaceChildren(
    h('div', { class: 'transport' }, play, speeds, scrub, liveInd, time, h('div', { class: 'spacer' }), preds, outcome),
    h('div', { class: 'feed-wrap' }, list, jump));

  let mode = 'replay';
  let duration = 0;
  let lastN = 0;
  let stick = true;
  let dragging = false;
  let pendingSeek = null;

  play.addEventListener('click', () => handlers.onToggle?.());
  speeds.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (b) handlers.onSpeed?.(Number(b.dataset.speed));
  });

  // scrubbing: pointer down / move seeks (once per frame), hovering shows the time under the pointer
  const tAt = (clientX) => {
    const r = scrub.getBoundingClientRect();
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * duration;
  };
  const flushSeek = () => {
    if (pendingSeek != null) handlers.onSeek?.(pendingSeek);
    pendingSeek = null;
  };
  scrub.addEventListener('pointerdown', (e) => {
    if (mode !== 'replay' || !duration) return;
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
    pendingSeek = tAt(e.clientX);
    requestAnimationFrame(flushSeek);
    setClass(scrub, 'dragging', true);
  });
  scrub.addEventListener('pointermove', (e) => {
    if (mode !== 'replay' || !duration) return;
    const t = tAt(e.clientX);
    const r = scrub.getBoundingClientRect();
    setHidden(tip, false);
    tip.style.left = `${clamp(e.clientX - r.left, 0, r.width)}px`;
    setText(tip, fmtClock(t));
    if (dragging) {
      if (pendingSeek == null) requestAnimationFrame(flushSeek);
      pendingSeek = t;
    }
  });
  const end = () => {
    dragging = false;
    setClass(scrub, 'dragging', false);
  };
  scrub.addEventListener('pointerup', end);
  scrub.addEventListener('pointercancel', end);
  scrub.addEventListener('pointerleave', () => setHidden(tip, true));

  list.addEventListener('scroll', () => {
    stick = list.scrollTop + list.clientHeight >= list.scrollHeight - STICK_PX;
    if (stick) setHidden(jump, true);
  }, { passive: true });
  jump.addEventListener('click', () => {
    list.scrollTop = list.scrollHeight;
    stick = true;
    setHidden(jump, true);
  });

  function lineEl(line, t0, animate = true) {
    const rel = line.t_wall != null && t0 != null ? line.t_wall - t0 : null;
    const li = h('li', { class: `ln${animate ? ' new' : ''}`, 'data-who': line.who, 'data-n': String(line.n) },
      h('time', { class: 'mono' }, rel != null ? fmtClockTenths(rel) : ''),
      h('span', { class: 'who', style: { color: `var(--${line.who}-ink, var(--muted))` } }, ACTOR_LABEL[line.who] || line.who),
      h('span', { class: 'tx' }, line.text));
    if (line.tone) li.dataset.tone = line.tone;
    return li;
  }

  function appendLines(st, ctx, rebuild) {
    const t0 = ctx.t0 ?? st.episode.t0_wall;
    if (rebuild) {
      list.replaceChildren(...st.feed.map((l) => lineEl(l, t0, false)));
      lastN = st.feed.length ? st.feed[st.feed.length - 1].n : 0;
      if (!st.feed.length) list.append(empty);
      list.scrollTop = list.scrollHeight;
      stick = true;
      setHidden(jump, true);
      return;
    }
    if (!st.feed.length || st.feed[st.feed.length - 1].n <= lastN) return;
    if (empty.isConnected) empty.remove();
    const frag = document.createDocumentFragment();
    for (const l of st.feed) if (l.n > lastN) frag.append(lineEl(l, t0));
    list.append(frag);
    lastN = st.feed[st.feed.length - 1].n;
    while (list.childElementCount > st.feed.length) list.firstElementChild.remove();
    if (stick) list.scrollTop = list.scrollHeight;
    else setHidden(jump, false);
  }

  return {
    /** 'replay' (controls and scrubber), 'live' (the LIVE indicator) or 'empty' (nothing to play). */
    setMode(m) {
      mode = m;
      setHidden(play, m !== 'replay');
      setHidden(speeds, m !== 'replay');
      setHidden(scrub, m !== 'replay');
      setHidden(time, m !== 'replay');
      setHidden(liveInd, m !== 'live');
      setClass(root, 'is-live', m === 'live');
      setClass(root, 'is-empty', m === 'empty');
    },
    /** The episode's event ticks `[{t, who}]` and its duration (seconds). */
    setTicks(list2, dur) {
      duration = Math.max(0, num(dur, 0));
      setAttr(scrub, 'aria-valuemax', duration.toFixed(1));
      ticks.replaceChildren(...(list2 || []).map((k) => s('line', {
        x1: (1000 * k.t) / (duration || 1), x2: (1000 * k.t) / (duration || 1), y1: k.who === 'llm' ? 4 : 2, y2: 12,
        class: `tk tk-${k.who}`, stroke: actorVar(k.who), 'vector-effect': 'non-scaling-stroke',
      })));
    },
    setPlaying(on) {
      playIcon.setAttribute('d', on ? ICON_PAUSE : ICON_PLAY);
      setAttr(play, 'aria-label', on ? 'Pause' : 'Play');
      setClass(play, 'on', on);
    },
    setSpeed(n) {
      for (const b of speeds.querySelectorAll('button')) setClass(b, 'on', Number(b.dataset.speed) === n);
    },
    /** The clock: `t_rel` seconds into a replay, or the live elapsed seconds. */
    setTime(tRel) {
      const t = num(tRel, 0);
      if (mode === 'replay') {
        const f = duration ? clamp(t / duration, 0, 1) : 0;
        played.style.width = `${(100 * f).toFixed(2)}%`;
        knob.style.left = `${(100 * f).toFixed(2)}%`;
        setAttr(scrub, 'aria-valuenow', t.toFixed(1));
        setText(time, `${fmtClock(t)} / ${fmtClock(duration)}`);
      } else if (mode === 'live') {
        setText(el(liveInd, '.live-t'), fmtClock(t));
      }
    },
    render(st, ctx = {}) {
      appendLines(st, ctx, false);
      const pr = st.episode.predicates || {};
      for (const p of preds.querySelectorAll('.pred')) {
        const on = pr[p.dataset.pred] === true;
        setClass(p, 'on', on);
        setAttr(p, 'title', `${p.dataset.pred}: ${on ? 'holds' : 'does not hold'}`);
      }
      const o = st.episode.outcome;
      const status = st.episode.status;
      const showRunning = !o && status && status !== 'idle';
      setHidden(outcome, !o && !showRunning);
      setText(outcome, o ? (o === 'success' ? 'success' : `failed · ${o}`) : showRunning ? status : '');
      setClass(outcome, 'ok', o === 'success');
      setClass(outcome, 'fail', !!o && o !== 'success');
      setAttr(outcome, 'title', st.episode.message || null);
    },
    /** Redraw the whole feed (after a seek or a reconnect). */
    reset(st, ctx = {}) {
      appendLines(st, ctx, true);
    },
  };
}

function el(root, sel) {
  return root.querySelector(sel);
}
