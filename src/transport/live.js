// The live transport: a WebSocket to a running simulator's web bridge (docs/design/WEB_HUD.md section 5.1).
//
// The bridge sends `hello`, `scene`, `library` and the row history at connect, then every new row and a `state`
// frame (`qpos`, sim time, control mode) at `web.state_hz`. The client sends `move_object` when a viewer drops an
// object and a periodic `ping`. A dropped connection is retried with exponential backoff; the bridge replays its
// history on every connect, so the page rebuilds its state from `rows` each time.

import { num } from '../util/format.js';

export const DEFAULT_WS = 'ws://127.0.0.1:8766/ws';
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 10000;
const PING_MS = 15000;
const MIRROR_DELAY_S = 0.1;   // the mirror renders this far behind the newest frame, so it can interpolate
const MIRROR_KEEP = 40;       // state frames kept for interpolation (2 s at 20 Hz)

/**
 * Connect to `url` (`ws://host:port/ws`). `handlers`: `onHello`, `onScene`, `onLibrary`, `onRows`, `onRow`, `onState`,
 * `onAck`, `onStatus(connected | reconnecting | closed, info)`. Returns `{send(msg), close(), connected, url}`.
 */
export function connectLive(url, handlers = {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;
  let pingTimer = null;

  const call = (name, ...args) => {
    try {
      handlers[name]?.(...args);
    } catch (e) {
      console.error(`live ${name}:`, e);
    }
  };

  function dispatch(msg) {
    switch (msg && msg.type) {
      case 'hello': call('onHello', msg); break;
      case 'scene': call('onScene', msg.scene); break;
      case 'library': call('onLibrary', Array.isArray(msg.items) ? msg.items : []); break;
      case 'rows': call('onRows', Array.isArray(msg.rows) ? msg.rows : []); break;
      case 'row': if (msg.row) call('onRow', msg.row); break;
      case 'state': call('onState', msg); break;
      case 'ack': call('onAck', msg); break;
      case 'pong': call('onPong', msg); break;
      default:
    }
  }

  function retry() {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    attempt += 1;
    call('onStatus', 'reconnecting', { delay_ms: delay, attempt });
    retryTimer = setTimeout(open, delay);
  }

  function open() {
    if (closed) return;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      call('onStatus', 'closed', { error: String(e && e.message ? e.message : e) });
      return;
    }
    ws = sock;
    let lost = false;
    // browsers follow an error with a close, some runtimes report a refused connection with the error alone: whichever
    // comes first ends this socket (once) and schedules the next attempt
    const onLost = () => {
      if (lost) return;
      lost = true;
      clearInterval(pingTimer);
      try {
        sock.close();
      } catch {
        /* already closing */
      }
      if (!closed) retry();                 // an explicit close() reported 'closed' itself
    };
    sock.onopen = () => {
      attempt = 0;
      call('onStatus', 'connected', { url });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
    };
    sock.onmessage = (ev) => {
      if (lost) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      dispatch(msg);
    };
    sock.onclose = onLost;
    sock.onerror = onLost;
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    call('onStatus', 'closed', {});
  }

  open();
  return {
    url,
    send,
    close,
    get connected() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}

/** The bridge's HTTP origin for a WebSocket URL: ws://127.0.0.1:8766/ws -> http://127.0.0.1:8766/. */
export function httpBase(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/';
  u.search = '';
  u.hash = '';
  return u.href;
}

/** The model URL of a `hello` (relative to the bridge's origin). */
export function modelUrlFor(wsUrl, modelUrl = '/api/model.mjb') {
  return new URL(modelUrl || '/api/model.mjb', httpBase(wsUrl)).href;
}

/** Fetch the compiled scene (`.mjb`) as an ArrayBuffer. */
export async function fetchModel(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model ${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}

/**
 * A small jitter buffer for the state frames: `push(msg)` on every `state` message, `sample(nowMs)` once per
 * animation frame returns `{qpos, t, t_wall}` interpolated at the bridge's clock a little behind the newest frame,
 * so the mirror moves smoothly at the display rate although frames arrive at 20 Hz.
 */
export function createLiveMirror() {
  const frames = [];
  let recvMs = null;
  let out = null;
  return {
    push(msg, nowMs = performance.now()) {
      const tw = num(msg.t_wall);
      if (tw == null || !Array.isArray(msg.qpos)) return;
      if (frames.length && tw <= frames[frames.length - 1].t_wall) frames.length = 0;   // a restart of the clock
      frames.push({ t_wall: tw, t: num(msg.t), qpos: msg.qpos });
      if (frames.length > MIRROR_KEEP) frames.shift();
      recvMs = nowMs;
    },
    /** The bridge's wall clock now (seconds), estimated from the newest frame. */
    now(nowMs = performance.now()) {
      if (!frames.length || recvMs == null) return null;
      return frames[frames.length - 1].t_wall + (nowMs - recvMs) / 1000;
    },
    sample(nowMs = performance.now()) {
      if (!frames.length) return null;
      const target = this.now(nowMs) - MIRROR_DELAY_S;
      let a = frames[0];
      let b = frames[frames.length - 1];
      if (target <= a.t_wall) b = a;
      else if (target < b.t_wall) {
        for (let i = frames.length - 1; i > 0; i--) {
          if (frames[i - 1].t_wall <= target) {
            a = frames[i - 1];
            b = frames[i];
            break;
          }
        }
      } else a = b;
      const n = b.qpos.length;
      if (!out || out.length !== n) out = new Float64Array(n);
      const f = b.t_wall > a.t_wall ? Math.min(1, Math.max(0, (target - a.t_wall) / (b.t_wall - a.t_wall))) : 1;
      for (let k = 0; k < n; k++) out[k] = a.qpos[k] + (b.qpos[k] - a.qpos[k]) * f;
      const t = a.t != null && b.t != null ? a.t + (b.t - a.t) * f : b.t;
      return { qpos: out, t, t_wall: target };
    },
  };
}
