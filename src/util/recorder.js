// The page records itself (web/README.md, "Recording"): the browser's screen capture of this tab, encoded by a
// MediaRecorder into chunks kept in memory, and downloaded as one video file when the recording stops. Chrome offers
// "This tab" first (preferCurrentTab); other browsers show their own picker. Nothing here touches the page until
// start(), so the module also loads in node (tests/test_pipeline.mjs checks pickMimeType).
//
//   const rec = createRecorder({ onState: ({recording, elapsed_s}) => ..., onError: (msg) => ... });
//   await rec.start('interesting_003_tabletop_random_s3_claude');   // -> <name>_<YYYYMMDD-HHMMSS>.webm on stop
//   rec.stop();

/** The containers tried in order: VP9 WebM keeps the HUD's small text sharp at a low rate, VP8 and plain WebM come
 * next (older Chrome, Firefox), MP4 last (Safari records nothing else). */
export const MIME_TYPES = Object.freeze(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']);

/** The capture request: this tab at 30 frames per second, without sound; the picker offers no whole screens and no
 * switching to another surface mid-recording. */
const CAPTURE = Object.freeze({
  // displaySurface 'browser' opens Chrome's picker on its tab pane, where preferCurrentTab lists "This Tab" first
  video: { frameRate: 30, displaySurface: 'browser' },
  audio: false,
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
  surfaceSwitching: 'exclude',
  monitorTypeSurfaces: 'exclude',
});
const TIMESLICE_MS = 1000;        // a chunk every second: the recording grows in memory instead of in one last flush
const TICK_MS = 1000;             // the elapsed time is reported once a second
const REVOKE_MS = 10000;          // the download has started long before the object URL is freed

export const REFUSED = 'Recording needs screen capture: allow it and pick this tab';
/** Screen capture exists only on a secure origin: https, or http on localhost / 127.0.0.1. */
export const INSECURE = 'Recording needs a secure page: open it at http://localhost or https (not a LAN address)';

/** The first of MIME_TYPES the MediaRecorder class (or a stand-in with `isTypeSupported`) accepts, else null. */
export function pickMimeType(Recorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return null;
  for (const type of MIME_TYPES) {
    try {
      if (Recorder.isTypeSupported(type)) return type;
    } catch {
      /* a browser that throws for a type it does not know: try the next one */
    }
  }
  return null;
}

/** `<name>_<YYYYMMDD-HHMMSS>.<webm|mp4>` in local time; the name keeps letters, digits, dot, dash and underscore. */
export function recordingName(name, mimeType, date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-`
    + `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  const base = String(name || 'live').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'live';
  return `${base}_${stamp}.${String(mimeType || '').startsWith('video/mp4') ? 'mp4' : 'webm'}`;
}

/**
 * A recorder of this tab. `onState({recording, elapsed_s})` fires on start, once a second while recording and on
 * stop; `onError(message)` when the capture is refused or the browser cannot record (the recorder is idle again).
 */
export function createRecorder({ onState, onError } = {}) {
  let stream = null;
  let rec = null;
  let chunks = [];
  let type = null;
  let name = 'live';
  let startedMs = 0;
  let timer = 0;
  let starting = false;

  const elapsed = () => (rec ? Math.floor((performance.now() - startedMs) / 1000) : 0);
  const emit = () => onState?.({ recording: !!rec, elapsed_s: elapsed() });

  function release() {
    clearInterval(timer);
    timer = 0;
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    rec = null;
  }

  function fail() {
    release();
    starting = false;
    emit();
    onError?.(REFUSED);
  }

  function save(parts, mimeType, fileName) {
    if (!parts.length) return;
    const blob = new Blob(parts, { type: mimeType || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
  }

  async function start(fileBase = 'live') {
    if (rec || starting) return false;
    const Recorder = globalThis.MediaRecorder;
    type = pickMimeType(Recorder);
    if (!globalThis.navigator?.mediaDevices?.getDisplayMedia) {
      onError?.(globalThis.isSecureContext === false ? INSECURE : REFUSED);
      return false;
    }
    if (!type) {
      onError?.(REFUSED);
      return false;
    }
    starting = true;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(CAPTURE);
    } catch {
      fail();                                   // the picker was dismissed or the capture is not allowed here
      return false;
    }
    try {
      rec = new Recorder(stream, { mimeType: type });
    } catch {
      fail();
      return false;
    }
    name = fileBase;
    chunks = [];
    const mine = rec;
    const parts = chunks;
    const fileName = () => recordingName(name, type);
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) parts.push(e.data);
    };
    // the recorder's own stop (a second click, the browser's "Stop sharing") writes the file; a page going away
    // stops it as well, but the stop event comes after the page, so that file is usually lost
    rec.onstop = () => {
      save(parts, mine.mimeType || type, fileName());
      if (rec === mine) release();
      emit();
    };
    // "Stop sharing" in the browser's bar ends the video track: that stops the recording too
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => stop(), { once: true });
    try {
      rec.start(TIMESLICE_MS);
    } catch {
      fail();
      return false;
    }
    startedMs = performance.now();
    starting = false;
    timer = setInterval(emit, TICK_MS);
    emit();
    return true;
  }

  function stop() {
    if (!rec) return;
    clearInterval(timer);
    timer = 0;
    if (rec.state !== 'inactive') {
      try {
        rec.stop();                             // the stop event saves the file and releases the capture
        return;
      } catch {
        /* already stopping: release below */
      }
    }
    release();
    emit();
  }

  return {
    start,
    stop,
    get recording() { return !!rec; },
    get elapsed_s() { return elapsed(); },
  };
}
