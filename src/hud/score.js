// The Score block under the panel's three blocks (contract H4, 2026-11-15): the record behind the bar's score chip. Its
// header always shows the primary's name and its value at the playhead; opened (a click on the header or on the chip,
// `?score=open`, or the visitor's last choice), it shows what the task asks, the protocol and the pass rule, the trials
// decided so far (newest at the bottom, as in the feed; a toss of eight pieces is one line that opens to its rows; a click
// on a line seeks to just before it) and, once the episode has ended, the result: the primary with its verdict, the pass
// rule and the metrics. It is closed by default so that the pipeline's blocks keep their room, and it sits indented, so
// the spine from the Engine to the motion memory runs past it. Everything comes from model/score.js scoreView, which
// reveals only what the playhead has passed.

import { h, setText, setAttr, setClass, setHidden } from '../util/dom.js';
import { fmtClockTenths, num } from '../util/format.js';
import { trialLines, metricRows, METRICS_OPEN, fmtPrimary } from '../model/score.js';

const STICK_PX = 8;         // the list follows new lines while the viewer is this close to its bottom
const MARK = { true: '✓', false: '✗', null: '·' };

/** `onSeek(tSim)`: a line was clicked (the app seeks to just before that sim time; nothing in a live run). `onToggle(open)`:
 * the visitor opened or closed the block (the app keeps the choice). `open`: the state at load. */
export function createScoreBlock({ onSeek, onToggle, open = false } = {}) {
  const now = h('span', { class: 'sc-now mono' });
  const caret = h('span', { class: 'sc-caret', 'aria-hidden': 'true' });
  const head = h('header', { class: 'bh sc-head', role: 'button', tabindex: '0', 'aria-expanded': String(!!open),
    title: 'The scorecard: what the task asks, the trials so far, the result' },
  h('span', { class: 'dot', 'aria-hidden': 'true' }),
  h('h2', { class: 'bt' }, 'Score', h('span', { class: 'sub' })),
  now, caret);
  const task = h('p', { class: 'sc-task' });
  const protocol = h('dd', { class: 'sc-protocol' });
  const pass = h('dd', { class: 'sc-pass' });
  const count = h('span', { class: 'sc-count mono' });
  const list = h('ol', { class: 'sc-trials', 'aria-label': 'The trials decided so far' });
  const none = h('p', { class: 'sc-none' }, 'No trial decided yet.');
  const resValue = h('span', { class: 'sc-rv mono' });
  const resLabel = h('span', { class: 'sc-rl' });
  const resVerdict = h('span', { class: 'pill mono sc-verdict' });
  const resRule = h('p', { class: 'sc-rrule' });
  const metricsOpen = h('table', { class: 'sc-metrics' });
  const metricsMore = h('table', { class: 'sc-metrics' });
  const more = h('details', { class: 'sc-more', hidden: true }, h('summary', { class: 'mono' }), metricsMore);
  const result = h('section', { class: 'sc-result', hidden: true, 'aria-label': 'The result' },
    h('div', { class: 'row-head' }, h('span', { class: 'lbl' }, 'result')),
    h('p', { class: 'sc-rhead' }, resValue, resLabel, resVerdict),
    resRule, metricsOpen, more);
  // once the episode has ended the result comes before the trials, and the pass rule moves into it
  const body = h('div', { class: 'sc-body', hidden: !open },
    task,
    h('dl', { class: 'sc-rules' }, h('dt', { class: 'lbl' }, 'protocol'), protocol,
      h('dt', { class: 'lbl sc-pass-l' }, 'pass rule'), pass),
    result,
    h('div', { class: 'row-head sc-trials-head' }, h('span', { class: 'lbl sc-trials-l' }, 'trials so far'), count),
    list, none);
  const root = h('article', { class: 'block score-block', 'data-actor': 'score', hidden: true }, head, body);

  let isOpen = !!open;
  let listKey = null;
  let resultKey = null;
  let stick = true;
  const expanded = new Set();     // the groups the visitor opened (by their `n`)

  function setOpen(v, fromUser = false) {
    isOpen = !!v;
    setHidden(body, !isOpen);
    setAttr(head, 'aria-expanded', String(isOpen));
    setClass(root, 'open', isOpen);
    listKey = null;
    if (fromUser) onToggle?.(isOpen);
  }
  setOpen(isOpen);
  head.addEventListener('click', () => setOpen(!isOpen, true));
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!isOpen, true);
    }
  });
  list.addEventListener('scroll', () => {
    stick = list.scrollTop + list.clientHeight >= list.scrollHeight - STICK_PX;
  }, { passive: true });
  list.addEventListener('click', (e) => {
    const tog = e.target.closest('button.sc-tog');
    if (tog) {
      const n = tog.dataset.n;
      if (expanded.has(n)) expanded.delete(n);
      else expanded.add(n);
      listKey = null;
      return;
    }
    const seek = e.target.closest('button.sc-seek');
    if (seek && seek.dataset.t !== '') onSeek?.(Number(seek.dataset.t));
  });

  /** A line's time: the time bar's clock (`ctx.relAt`, a replay), else the seconds since the episode began (live). */
  function timeText(t, ctx, st) {
    if (t == null) return '';
    if (typeof ctx.relAt === 'function') {
      const rel = ctx.relAt(t);
      return rel != null ? fmtClockTenths(rel) : '';
    }
    const start = num(st.episode.t_start);
    return fmtClockTenths(start != null ? t - start : t);
  }

  function lineEl(line, ctx, st, sub = false) {
    const ok = line.ok === true ? 'true' : line.ok === false ? 'false' : 'null';
    const seek = h('button', { class: 'sc-seek', type: 'button', 'data-t': line.t != null ? String(line.t) : '',
      title: `${line.title}${line.t != null && typeof ctx.relAt === 'function' ? '\n(click: replay from just before it)' : ''}` },
    h('time', { class: 'mono' }, timeText(line.t, ctx, st)),
    h('i', { class: 'mk', 'aria-label': line.ok === true ? 'went the player\'s way' : line.ok === false ? 'did not' : 'no verdict' },
      MARK[ok]),
    h('span', { class: 'lb mono' }, line.label),
    h('span', { class: 'fx' }, line.fields.join(' · ')));
    const li = h('li', { class: `sc-line${sub ? ' sub' : ''}`, 'data-ok': ok });
    if (line.rows) {
      const open = expanded.has(String(line.n));
      li.classList.add('grp');
      li.append(h('button', { class: 'sc-tog', type: 'button', 'data-n': String(line.n), 'aria-expanded': String(open),
        title: open ? 'close its rows' : 'open its rows' }, open ? '▾' : '▸'), seek);
      if (open) li.append(h('ol', { class: 'sc-sub' }, ...line.rows.map((x) => lineEl(x, ctx, st, true))));
    } else {
      li.append(h('span', { class: 'sc-tog-gap', 'aria-hidden': 'true' }), seek);
    }
    return li;
  }

  function renderList(v, ctx, st) {
    const key = `${v.rows.length}|${v.ended}|${[...expanded].join(',')}|${typeof ctx.relAt === 'function'}`;
    if (key === listKey) return;
    listKey = key;
    const lines = trialLines(v.card, v.rows);
    const total = v.card ? v.card.trials.length : 0;
    setText(count, v.card ? `${lines.length}${v.ended ? '' : ' so far'}` : '');
    setAttr(count, 'title', v.card && v.ended ? `${total} row${total === 1 ? '' : 's'} in the card` : null);
    const keepBottom = stick;
    list.replaceChildren(...lines.map((x) => lineEl(x, ctx, st)));
    setHidden(list, !lines.length);
    setHidden(none, !!lines.length);
    setText(none, v.card ? 'No trial decided yet.' : 'The trials come with the episode\'s end.');
    if (keepBottom) list.scrollTop = list.scrollHeight;
  }

  function renderResult(v) {
    const show = v.ended && !!v.card;
    setHidden(result, !show);
    if (!show) {
      resultKey = null;
      return;
    }
    const key = `${v.card.primary.value}|${v.mark}|${v.final}|${Object.keys(v.card.metrics).length}`;
    if (key === resultKey) return;
    resultKey = key;
    const p = v.card.primary;
    setText(resValue, fmtPrimary(p.value, p.of, p.unit));
    setText(resLabel, p.label);
    const verdict = v.mark ? `${v.mark}${v.final ? '' : ' · unfinished'}` : v.final ? '' : 'unfinished';
    setHidden(resVerdict, !verdict);
    // a failed verdict names its cause (the task's failure: timeout, component_flag); an unfinished one says so already
    const why = v.card.reason && v.mark === 'failed' && v.final ? ` · ${String(v.card.reason).replace(/_/g, ' ')}` : '';
    setText(resVerdict, `${verdict}${why}`);
    setClass(resVerdict, 'ok', v.mark === 'passed');
    setClass(resVerdict, 'fail', v.mark === 'failed');
    setText(resRule, v.card.pass_rule ?? (v.head && v.head.pass_rule) ?? '');
    setHidden(resRule, !(v.card.pass_rule ?? (v.head && v.head.pass_rule)));
    const rows = metricRows(v.card.metrics);
    const tr = ([label, text, name]) => h('tr', { title: name }, h('th', { scope: 'row' }, label), h('td', { class: 'mono' }, text));
    metricsOpen.replaceChildren(...rows.slice(0, METRICS_OPEN).map(tr));
    metricsMore.replaceChildren(...rows.slice(METRICS_OPEN).map(tr));
    setHidden(more, rows.length <= METRICS_OPEN);
    setText(more.querySelector('summary'), `more (${rows.length - METRICS_OPEN})`);
  }

  return {
    el: root,
    get open() { return isOpen; },
    setOpen,
    /** `v`: model/score.js scoreView at the playhead (null: the block is not shown). */
    render(v, st, ctx = {}) {
      setHidden(root, !v);
      if (!v) return;
      setText(el(head, '.sub'), v.label);
      setText(now, `${v.text}${v.mark ? ` ${v.mark === 'passed' ? '✓' : '✗'}` : ''}`);
      setClass(now, 'ok', v.mark === 'passed');
      setClass(now, 'fail', v.mark === 'failed');
      setText(caret, isOpen ? '▾' : '▸');
      const done = v.ended && !!v.card;
      setClass(root, 'ended', done);
      if (!isOpen) return;
      setText(el(body, '.sc-trials-l'), done ? 'trials' : 'trials so far');
      const h0 = v.head || {};
      setText(task, h0.sentence ?? '');
      setHidden(task, !h0.sentence);
      setText(protocol, h0.protocol ?? '–');
      setAttr(protocol, 'title', h0.protocol ?? null);
      setText(pass, h0.pass_rule ?? '–');
      setAttr(pass, 'title', h0.pass_rule ?? null);
      renderList(v, ctx, st);
      renderResult(v);
    },
    /** After a seek: the list is drawn afresh and follows the newest line again. */
    reset() {
      listKey = null;
      resultKey = null;
      stick = true;
    },
  };
}

function el(root, sel) {
  return root.querySelector(sel);
}
