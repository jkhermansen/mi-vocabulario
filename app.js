'use strict';

// ── OpenAI TTS config ──────────────────────────────────────────────────────
// __OPENAI_API_KEY__ is replaced at build time by the GitHub Actions workflow.
// It is NOT in the git repository. It IS visible in the deployed JS bundle.
const OPENAI_API_KEY = '__OPENAI_API_KEY__';
const TTS_CACHE      = 'mv-tts-v1';
const EN_VOICE       = 'alloy';
const ES_VOICE       = 'nova';
const TTS_MODEL      = 'tts-1';

// ── Default word list ──────────────────────────────────────────────────────
const DEFAULT_WORDS = [
  { en: 'hello',     es: 'hola' },
  { en: 'thank you', es: 'gracias' },
  { en: 'please',    es: 'por favor' },
  { en: 'goodbye',   es: 'adiós' },
  { en: 'yes',       es: 'sí' },
  { en: 'no',        es: 'no' },
  { en: 'water',     es: 'agua' },
  { en: 'food',      es: 'comida' },
  { en: 'where is',  es: 'dónde está' },
  { en: 'how much',  es: 'cuánto cuesta' },
];

// ── State ──────────────────────────────────────────────────────────────────
let words = [];
let settings = {
  pauseMs:       1500,
  repeatSpanish: 2,
  rate:          1.0,
  autoLoop:      true,
  shufflePlayback: false,
};

let playerState = {
  playing:     false,
  index:       0,
  phase:       'idle',  // idle | generating | english | english-sent | pause | spanish | spanish-sent | done
  playOrder:   [],
  generation:  0,       // increment on skip/stop so in-flight playWord exits early
  pairSentIdx: null,    // index of sentence entry in words[] while playing a pair; null otherwise
};

let flashState = {
  index:     0,
  revealed:  false,
  correct:   0,
  incorrect: 0,
  deck:      [],
};

let keepAliveInterval = null;

// ── Persistence ────────────────────────────────────────────────────────────
function save() {
  localStorage.setItem('mv_words',    JSON.stringify(words));
  localStorage.setItem('mv_settings', JSON.stringify(settings));
}

function load() {
  try {
    const w = localStorage.getItem('mv_words');
    words = w ? JSON.parse(w) : [...DEFAULT_WORDS];
    const s = localStorage.getItem('mv_settings');
    if (s) {
      const saved = JSON.parse(s);
      // Drop stale voice keys from previous Web-Speech implementation
      delete saved.enVoice;
      delete saved.esVoice;
      Object.assign(settings, saved);
    }
  } catch {
    words = [...DEFAULT_WORDS];
  }
}

// ── TTS helpers ────────────────────────────────────────────────────────────
// Must stay in sync with textSlug() in generate-audio.js
function textSlug(text) {
  return text.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function clipKey(lang, text)    { return `/_tts/${lang}/${textSlug(text)}`; }
function staticPath(lang, text) { return `./audio/${lang}-${textSlug(text)}.mp3`; }

function apiKeyReady() {
  return Boolean(OPENAI_API_KEY && !OPENAI_API_KEY.startsWith('__'));
}

// Returns a Blob: TTS cache → pre-generated static file → OpenAI API
async function getOrGenerateAudio(text, lang) {
  const key   = clipKey(lang, text);
  const cache = await caches.open(TTS_CACHE);

  // 1. TTS cache (fastest — covers both static-file and API-generated clips)
  const hit = await cache.match(key);
  if (hit) return hit.blob();

  // 2. Pre-generated static file (deployed by CI for default words)
  try {
    const resp = await fetch(staticPath(lang, text));
    if (resp.ok) {
      await cache.put(key, resp.clone());
      return resp.blob();
    }
  } catch { /* offline or file missing — fall through */ }

  // 3. OpenAI TTS API (for custom words added by the user)
  if (!apiKeyReady()) throw new Error('OpenAI API key not configured');

  const voice = lang === 'es' ? ES_VOICE : EN_VOICE;
  const resp  = await fetch('https://api.openai.com/v1/audio/speech', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice, response_format: 'mp3' }),
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(`OpenAI ${resp.status}: ${msg}`);
  }

  await cache.put(key, resp.clone());
  return resp.blob();
}

// ── Audio playback element ─────────────────────────────────────────────────
// One element used for BOTH real clips and inter-clip silence.  By never
// letting it reach "ended" state during playback, Android retains audio focus
// across the gaps between words and through screen-lock events.
const wordAudio = new Audio();
let playbackResolve = null;
let silentBlobUrl   = null;
let wordAudioSilent = false;  // true while looping silence through wordAudio

function getOrMakeSilentUrl() {
  if (!silentBlobUrl) silentBlobUrl = makeSilentWavUrl(2);
  return silentBlobUrl;
}

// Switch wordAudio to a near-silent loop so Android audio focus is held
// between clips.  Guard prevents resetting a loop that is already running.
function loopSilence() {
  if (wordAudioSilent) return;
  wordAudioSilent  = true;
  wordAudio.loop   = true;
  wordAudio.volume = 0.001;
  wordAudio.src    = getOrMakeSilentUrl();
  wordAudio.play().catch(() => {});
}

function abortAudio() {
  wordAudioSilent = false;
  wordAudio.loop  = false;
  wordAudio.pause();
  wordAudio.removeAttribute('src');
  wordAudio.load();
  if (playbackResolve) {
    const r = playbackResolve;
    playbackResolve = null;
    r();
  }
}

function playBlob(blob) {
  return new Promise(resolve => {
    // Leaving silence mode: clear flag before touching the element.
    wordAudioSilent        = false;
    wordAudio.loop         = false;
    wordAudio.volume       = 1;
    playbackResolve        = resolve;
    const url = URL.createObjectURL(blob);
    wordAudio.playbackRate = settings.rate;
    wordAudio.src          = url;

    const done = () => {
      URL.revokeObjectURL(url);
      // Resume silence immediately so Android never sees wordAudio in "ended"
      // state — the guard in loopSilence() makes this cheap when already looping.
      if (playerState.playing) loopSilence();
      if (playbackResolve === resolve) { playbackResolve = null; resolve(); }
    };
    wordAudio.onended = done;
    wordAudio.onerror = done;
    wordAudio.play().catch(done);
  });
}

// speak() used by flashcard mode (no bail-check needed there)
async function speak(text, lang) {
  try {
    const blob = await getOrGenerateAudio(text, lang);
    await playBlob(blob);
  } catch (e) {
    console.warn('speak error:', e.message);
  }
}

// ── delay() with abort support ─────────────────────────────────────────────
// The old setTimeout-only approach left delay() hanging forever when
// clearTimeout was called, because the Promise resolve was never invoked.
let deferTimer      = null;
let delayResolve    = null;

function delay(ms) {
  return new Promise(resolve => {
    delayResolve = resolve;
    deferTimer   = setTimeout(() => { delayResolve = null; resolve(); }, ms);
  });
}

function abortDelay() {
  if (deferTimer)    { clearTimeout(deferTimer); deferTimer = null; }
  if (delayResolve)  { const r = delayResolve; delayResolve = null; r(); }
}

// ── Background preloading ──────────────────────────────────────────────────
async function preloadWord(wordObj) {
  await Promise.allSettled([
    getOrGenerateAudio(wordObj.en, 'en'),
    getOrGenerateAudio(wordObj.es, 'es'),
  ]);
}

async function preloadAll() {
  const list = [...words];
  for (let i = 0; i < list.length; i += 3) {
    await Promise.allSettled(list.slice(i, i + 3).map(preloadWord));
    if (i + 3 < list.length) await new Promise(r => setTimeout(r, 500));
  }
  updateTtsStatus();
}

// ── Silent WAV builder — used by loopSilence() via getOrMakeSilentUrl() ────
function makeSilentWavUrl(secs = 2, rate = 8000) {
  const n   = rate * secs;
  const buf = new ArrayBuffer(44 + n);
  const v   = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0,  'RIFF'); v.setUint32(4,  36 + n, true);
  str(8,  'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16,    true);
                   v.setUint16(20, 1,     true);
                   v.setUint16(22, 1,     true);
                   v.setUint32(24, rate,  true);
                   v.setUint32(28, rate,  true);
                   v.setUint16(32, 1,     true);
                   v.setUint16(34, 8,     true);
  str(36, 'data'); v.setUint32(40, n,     true);
  for (let i = 44; i < 44 + n; i++) v.setUint8(i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// ── Keep-alive — periodic SW ping so the service worker does not sleep ─────
function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(() => {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      const chan = new MessageChannel();
      navigator.serviceWorker.controller.postMessage({ type: 'KEEP_ALIVE' }, [chan.port2]);
    }
  }, 25000);
}

function stopKeepAlive() {
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

// ── Paul Noble playback engine ─────────────────────────────────────────────
async function playWord(wordObj, gen) {
  const bail = () => playerState.generation !== gen || !playerState.playing;
  const { en, es } = wordObj;

  // Hold audio focus while clips are fetched.  The guard in loopSilence()
  // makes this a no-op when silence is already running (e.g., end-of-word gap).
  loopSilence();

  // ── English ──
  playerState.phase = 'generating';
  updatePlayerUI();
  showSpanish(false);

  let enBlob = null;
  try { enBlob = await getOrGenerateAudio(en, 'en'); } catch (e) { toast(`TTS: ${e.message}`); }
  if (bail()) return;

  playerState.phase = 'english';
  updatePlayerUI();
  if (enBlob) { await playBlob(enBlob); }
  if (bail()) return;

  // ── Pause ──
  playerState.phase = 'pause';
  updatePlayerUI();
  await delay(settings.pauseMs);
  if (bail()) return;

  // ── Spanish × N ──
  playerState.phase = 'generating';
  updatePlayerUI();
  showSpanish(true);

  let esBlob = null;
  try { esBlob = await getOrGenerateAudio(es, 'es'); } catch (e) { toast(`TTS: ${e.message}`); }
  if (bail()) return;

  playerState.phase = 'spanish';
  updatePlayerUI();

  for (let i = 0; i < settings.repeatSpanish; i++) {
    if (bail()) return;
    if (esBlob) { await playBlob(esBlob); }
    if (bail()) return;
    if (i < settings.repeatSpanish - 1) { await delay(600); if (bail()) return; }
  }

  playerState.phase = 'done';
  updatePlayerUI();
  await delay(500);
}

async function playPair(word, sent, gen) {
  const bail = () => playerState.generation !== gen || !playerState.playing;

  loopSilence();

  // ── 1. English word ──────────────────────────────────────────────────────
  playerState.phase = 'generating';
  updatePlayerUI();
  showSpanish(false);
  showSentenceSpanish(false);

  let enWBlob = null;
  try { enWBlob = await getOrGenerateAudio(word.en, 'en'); } catch (e) { toast(`TTS: ${e.message}`); }
  if (bail()) return;

  playerState.phase = 'english';
  updatePlayerUI();
  if (enWBlob) await playBlob(enWBlob);
  if (bail()) return;

  // ── 2. Pause ─────────────────────────────────────────────────────────────
  playerState.phase = 'pause';
  updatePlayerUI();
  await delay(settings.pauseMs);
  if (bail()) return;

  // ── 3. Spanish word × N ──────────────────────────────────────────────────
  playerState.phase = 'generating';
  updatePlayerUI();
  showSpanish(true);

  let esWBlob = null;
  try { esWBlob = await getOrGenerateAudio(word.es, 'es'); } catch (e) { toast(`TTS: ${e.message}`); }
  if (bail()) return;

  playerState.phase = 'spanish';
  updatePlayerUI();

  for (let i = 0; i < settings.repeatSpanish; i++) {
    if (bail()) return;
    if (esWBlob) await playBlob(esWBlob);
    if (bail()) return;
    if (i < settings.repeatSpanish - 1) { await delay(600); if (bail()) return; }
  }
  if (bail()) return;

  // ── 4. Pause ─────────────────────────────────────────────────────────────
  playerState.phase = 'pause';
  updatePlayerUI();
  await delay(settings.pauseMs);
  if (bail()) return;

  // ── 5. English sentence ───────────────────────────────────────────────────
  playerState.phase = 'generating';
  updatePlayerUI();

  let enSBlob = null;
  try { enSBlob = await getOrGenerateAudio(sent.en, 'en'); } catch (e) { toast(`TTS: ${e.message}`); }
  if (bail()) return;

  playerState.phase = 'english-sent';
  updatePlayerUI();
  if (enSBlob) await playBlob(enSBlob);
  if (bail()) return;

  // ── 6. Pause ─────────────────────────────────────────────────────────────
  playerState.phase = 'pause';
  updatePlayerUI();
  await delay(settings.pauseMs);
  if (bail()) return;

  // ── 7. Spanish sentence × N ───────────────────────────────────────────────
  playerState.phase = 'generating';
  updatePlayerUI();
  showSentenceSpanish(true);

  let esSBlob = null;
  try { esSBlob = await getOrGenerateAudio(sent.es, 'es'); } catch (e) { toast(`TTS: ${e.message}`); }
  if (bail()) return;

  playerState.phase = 'spanish-sent';
  updatePlayerUI();

  for (let i = 0; i < settings.repeatSpanish; i++) {
    if (bail()) return;
    if (esSBlob) await playBlob(esSBlob);
    if (bail()) return;
    if (i < settings.repeatSpanish - 1) { await delay(600); if (bail()) return; }
  }

  // ── 8. Pause before next pair ─────────────────────────────────────────────
  playerState.phase = 'done';
  updatePlayerUI();
  await delay(500);
}

async function runPlayback() {
  if (!words.length) { stopPlayback(); return; }

  while (playerState.playing) {
    const idx = playerState.playOrder[playerState.index];

    if (idx === undefined) {
      if (settings.autoLoop) { playerState.index = 0; buildPlayOrder(); continue; }
      stopPlayback(); break;
    }

    const gen = playerState.generation;

    if (isPairAt(idx)) {
      playerState.pairSentIdx = idx + 1;
      highlightWord(idx);
      updateMediaSessionMeta(words[idx]);
      await playPair(words[idx], words[idx + 1], gen);
    } else {
      playerState.pairSentIdx = null;
      highlightWord(idx);
      updateMediaSessionMeta(words[idx]);
      await playWord(words[idx], gen);
    }

    if (!playerState.playing) break;
    if (playerState.generation === gen) playerState.index++;
  }
}

// ── Pair detection ─────────────────────────────────────────────────────────
function isSentenceEntry(w)  { return w && w.type === 'sentence'; }
function isPairAt(i)         { return i + 1 < words.length && !isSentenceEntry(words[i]) && isSentenceEntry(words[i + 1]); }

// Return the position in playerState.playOrder whose group contains wordIdx.
function groupPositionOf(wordIdx) {
  for (let i = 0; i < playerState.playOrder.length; i++) {
    const g = playerState.playOrder[i];
    if (g === wordIdx || (isPairAt(g) && g + 1 === wordIdx)) return i;
  }
  return 0;
}

function buildPlayOrder() {
  // Each element is the group-start index in words[].
  // Paired entries (word + sentence) share one slot so they always play together.
  const order = [];
  let i = 0;
  while (i < words.length) {
    order.push(i);
    i += isPairAt(i) ? 2 : 1;
  }
  if (settings.shufflePlayback) {
    for (let j = order.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [order[j], order[k]] = [order[k], order[j]];
    }
  }
  playerState.playOrder = order;
}

function startPlayback(fromWordIdx = null) {
  if (!words.length) { toast('Add some words first!'); return; }

  playerState.generation++;
  abortAudio();
  abortDelay();

  playerState.playing = true;
  buildPlayOrder();  // must come before groupPositionOf()

  if (fromWordIdx !== null) playerState.index = groupPositionOf(fromWordIdx);

  updatePlayPauseBtn();
  setupMediaSession();
  startKeepAlive();
  runPlayback();
}

function stopPlayback() {
  playerState.generation++;
  playerState.playing    = false;
  playerState.phase      = 'idle';
  playerState.pairSentIdx = null;
  abortAudio();
  abortDelay();
  stopKeepAlive();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  updatePlayPauseBtn();
  updatePlayerUI();
  showSpanish(false);
  showSentenceSpanish(false);
  highlightWord(-1);
}

function skipNext() {
  if (!playerState.playing) return;
  playerState.generation++;
  playerState.index++;
  abortAudio();
  abortDelay();
}

function skipPrev() {
  if (!playerState.playing) return;
  playerState.generation++;
  playerState.index = Math.max(0, playerState.index - 1);
  abortAudio();
  abortDelay();
}

// ── Media Session API ──────────────────────────────────────────────────────
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play',          () => { if (!playerState.playing) startPlayback(); });
  navigator.mediaSession.setActionHandler('pause',         () => stopPlayback());
  navigator.mediaSession.setActionHandler('stop',          () => stopPlayback());
  navigator.mediaSession.setActionHandler('nexttrack',     () => skipNext());
  navigator.mediaSession.setActionHandler('previoustrack', () => skipPrev());
  navigator.mediaSession.playbackState = 'playing';
}

function updateMediaSessionMeta(word) {
  if (!('mediaSession' in navigator) || !word) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title:   word.en,
    artist:  word.es,
    album:   'Mi Vocabulario',
    artwork: [
      { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
  navigator.mediaSession.playbackState = 'playing';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playerState.playing) {
    // wordAudio may have been paused by the OS while backgrounded — resume it.
    if (wordAudio.paused) { wordAudioSilent = false; loopSilence(); }
  }
});

// ── UI Updates ─────────────────────────────────────────────────────────────
function updatePlayerUI() {
  const idx  = playerState.playOrder[playerState.index];
  const word = idx !== undefined ? words[idx] : null;
  const sent = playerState.pairSentIdx !== null ? words[playerState.pairSentIdx] : null;

  document.getElementById('player-english').textContent = word ? word.en : '—';
  document.getElementById('player-spanish').textContent = word ? word.es : '—';

  const pairWrap = document.getElementById('player-pair-wrap');
  if (sent) {
    document.getElementById('player-sent-en').textContent = sent.en;
    document.getElementById('player-sent-es').textContent = sent.es;
    pairWrap.classList.add('visible');
  } else {
    pairWrap.classList.remove('visible');
  }

  const total = playerState.playOrder.length;  // group count, not word count
  const pos   = playerState.index + 1;
  document.getElementById('progress-text').textContent =
    total ? `${Math.min(pos, total)} / ${total}` : '0 / 0';
  document.getElementById('progress-fill').style.width =
    total ? `${(Math.min(pos, total) / total) * 100}%` : '0%';

  const labels = {
    idle:           '',
    generating:     'Generating audio…',
    english:        'Speaking English…',
    'english-sent': 'Speaking English sentence…',
    pause:          'Pause…',
    spanish:        'Speaking Spanish…',
    'spanish-sent': 'Speaking Spanish sentence…',
    done:           '',
  };
  document.getElementById('phase-label').textContent = labels[playerState.phase] || '';
}

function showSpanish(show) {
  document.getElementById('player-spanish').classList.toggle('visible', show);
}

function showSentenceSpanish(show) {
  document.getElementById('player-sent-es').classList.toggle('visible', show);
}

function updatePlayPauseBtn() {
  document.getElementById('btn-play').textContent = playerState.playing ? '⏸' : '▶';
}

function highlightWord(idx) {
  const sentIdx = playerState.pairSentIdx;
  document.querySelectorAll('.word-item').forEach((el, i) => {
    el.classList.toggle('playing', i === idx || (sentIdx !== null && i === sentIdx));
  });
  if (idx >= 0) {
    const el = document.querySelectorAll('.word-item')[idx];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── TTS status (settings tab) ──────────────────────────────────────────────
function updateTtsStatus() {
  const keyEl   = document.getElementById('tts-key-status');
  const countEl = document.getElementById('tts-cache-count');
  if (!keyEl) return;

  const ready = apiKeyReady();
  keyEl.textContent = ready ? '✓ Configured' : '✗ Not configured';
  keyEl.style.color = ready ? 'var(--success)' : 'var(--accent)';

  if ('caches' in window) {
    caches.open(TTS_CACHE)
      .then(c => c.keys())
      .then(keys => { if (countEl) countEl.textContent = `${keys.length} clips cached`; })
      .catch(() => { if (countEl) countEl.textContent = 'unavailable'; });
  }
}

// ── Word Bank ──────────────────────────────────────────────────────────────
function renderWordList() {
  const list = document.getElementById('word-list');
  if (!words.length) {
    list.innerHTML = '<div class="empty-state"><span>📚</span><span>No words yet — add some above</span></div>';
    return;
  }
  list.innerHTML = words.map((w, i) => `
    <div class="word-item${w.type === 'sentence' ? ' sentence' : ''}" data-idx="${i}">
      <div class="wi-text">
        <div class="wi-en">${escHtml(w.en)}</div>
        <div class="wi-es">${escHtml(w.es)}</div>
      </div>
      <button class="wi-del" data-del="${i}" title="Delete">✕</button>
    </div>
  `).join('');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Flashcard mode ─────────────────────────────────────────────────────────
function buildDeck() {
  flashState.deck     = [...words].sort(() => Math.random() - 0.5);
  flashState.index    = 0;
  flashState.revealed = false;
}

function renderFlashcard() {
  if (!flashState.deck.length) {
    document.getElementById('fc-front').textContent = 'Add words first';
    document.getElementById('fc-back').textContent  = '';
    document.getElementById('fc-stats').textContent = '';
    return;
  }
  const w = flashState.deck[flashState.index];
  document.getElementById('fc-front').textContent = w ? w.en : '—';
  document.getElementById('fc-back').textContent  = w ? w.es : '—';
  document.getElementById('fc-back').classList.toggle('show', flashState.revealed);

  const total = flashState.correct + flashState.incorrect;
  const pct   = total ? Math.round((flashState.correct / total) * 100) : 0;
  document.getElementById('fc-stats').textContent =
    total ? `✓ ${flashState.correct}  ✗ ${flashState.incorrect}  (${pct}% correct)` : '';
  document.getElementById('fc-pos').textContent =
    flashState.deck.length ? `${flashState.index + 1} / ${flashState.deck.length}` : '';
}

function fcReveal() {
  flashState.revealed = true;
  renderFlashcard();
  const w = flashState.deck[flashState.index];
  if (w) speak(w.es, 'es');
}

function fcAnswer(correct) {
  if (!flashState.revealed) { fcReveal(); return; }
  if (correct) flashState.correct++; else flashState.incorrect++;
  flashState.index++;
  if (flashState.index >= flashState.deck.length) {
    toast(`Round done! ${flashState.correct} correct`);
    buildDeck();
  }
  flashState.revealed = false;
  renderFlashcard();
}

// ── Import / Export ────────────────────────────────────────────────────────
function exportWords() {
  const data = {
    version: 1,
    words: words.map((w, i) => ({
      id:      i + 1,
      type:    w.type === 'sentence' ? 'sentence' : 'word',
      english: w.en,
      spanish: w.es,
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(blob),
    download: 'vocabulario.json',
  });
  a.click();
}

function showImportModal() {
  document.getElementById('import-modal').classList.add('open');
  document.getElementById('import-text').value        = '';
  document.getElementById('import-file').value        = '';
  document.getElementById('import-file-name').textContent = '';
  document.getElementById('import-text').focus();
}

function closeImportModal() {
  document.getElementById('import-modal').classList.remove('open');
  document.getElementById('import-file').value        = '';
  document.getElementById('import-file-name').textContent = '';
}

function doImport() {
  const txt = document.getElementById('import-text').value.trim();
  console.log('[import] textarea length:', txt.length, '| first 80 chars:', JSON.stringify(txt.slice(0, 80)));

  if (!txt) {
    console.log('[import] empty textarea — closing modal');
    closeImportModal();
    return;
  }

  let added = 0;
  let skipped = 0;

  if (txt.startsWith('{')) {
    // ── JSON format ────────────────────────────────────────────────────────
    let data;
    try {
      data = JSON.parse(txt);
      console.log('[import] JSON parsed OK — version:', data.version, '| words count:', Array.isArray(data.words) ? data.words.length : 'NOT AN ARRAY');
    } catch (err) {
      console.error('[import] JSON.parse failed:', err.message);
      toast('Invalid JSON — check the file and try again');
      return;
    }

    if (data.version !== 1 || !Array.isArray(data.words)) {
      console.warn('[import] format check failed — version:', data.version, '| isArray:', Array.isArray(data.words));
      toast('Unrecognised format — expected {version:1, words:[…]}');
      return;
    }

    data.words.forEach((entry, i) => {
      const en   = String(entry.english != null ? entry.english : '').trim();
      const es   = String(entry.spanish != null ? entry.spanish : '').trim();
      const type = entry.type === 'sentence' ? 'sentence' : undefined;
      if (!en || !es) {
        console.log(`[import] entry ${i} skipped — blank fields: en="${en}" es="${es}"`);
        return;
      }
      if (words.find(w => w.en.toLowerCase() === en.toLowerCase())) {
        console.log(`[import] entry ${i} skipped — duplicate: "${en}"`);
        skipped++;
        return;
      }
      words.push(type ? { en, es, type } : { en, es });
      console.log(`[import] entry ${i} added: "${en}" → "${es}" (type: ${type || 'word'})`);
      added++;
    });
  } else {
    // ── TSV fallback ───────────────────────────────────────────────────────
    console.log('[import] TSV path — lines:', txt.split('\n').length);
    txt.split('\n').forEach((line, i) => {
      const parts = line.split('\t');
      if (!parts[0] || !parts[1]) {
        console.log(`[import] TSV line ${i} skipped — not enough columns`);
        return;
      }
      const en   = parts[0].trim();
      const es   = parts[1].trim();
      const type = parts[2] && parts[2].trim().toLowerCase() === 'sentence' ? 'sentence' : undefined;
      if (en && es && !words.find(w => w.en.toLowerCase() === en.toLowerCase())) {
        words.push(type ? { en, es, type } : { en, es });
        console.log(`[import] TSV line ${i} added: "${en}" → "${es}"`);
        added++;
      } else if (en && es) {
        console.log(`[import] TSV line ${i} skipped — duplicate: "${en}"`);
        skipped++;
      }
    });
  }

  console.log(`[import] done — added: ${added}, skipped (duplicates): ${skipped}, word bank now: ${words.length}`);
  save(); renderWordList(); buildDeck(); closeImportModal();
  if (added === 0 && skipped > 0) {
    toast(`All ${skipped} entries already in word bank`);
  } else if (added > 0 && skipped > 0) {
    toast(`Imported ${added} new, skipped ${skipped} duplicates`);
  } else {
    toast(`Imported ${added} entr${added !== 1 ? 'ies' : 'y'}`);
  }
  if (added) preloadAll();
}

// ── Install prompt ─────────────────────────────────────────────────────────
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById('install-btn').classList.add('visible');
});

function triggerInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => {
    deferredInstallPrompt = null;
    document.getElementById('install-btn').classList.remove('visible');
  });
}

// ── Tab navigation ─────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`));

  if (name === 'flashcard') { if (!flashState.deck.length) buildDeck(); renderFlashcard(); }
  if (name === 'settings')  updateTtsStatus();
  if (name === 'words')     renderWordList();
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Settings ───────────────────────────────────────────────────────────────
function applySettings() {
  settings.pauseMs         = parseInt(document.getElementById('set-pause').value,  10) || 1500;
  settings.repeatSpanish   = parseInt(document.getElementById('set-repeat').value, 10) || 2;
  settings.autoLoop        = document.getElementById('set-loop').checked;
  settings.shufflePlayback = document.getElementById('set-shuffle').checked;
  save();
  toast('Settings saved');
}

function syncSettingsToUI() {
  document.getElementById('set-pause').value       = settings.pauseMs;
  document.getElementById('set-repeat').value      = settings.repeatSpanish;
  document.getElementById('set-loop').checked      = settings.autoLoop;
  document.getElementById('set-shuffle').checked   = settings.shufflePlayback;
  document.getElementById('set-speed').value       = settings.rate;
  document.getElementById('speed-display').textContent = settings.rate.toFixed(1) + '×';
}

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  load();
  renderWordList();
  buildDeck();
  updatePlayerUI();
  syncSettingsToUI();

  // Tab bar
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // Player controls
  document.getElementById('btn-play').addEventListener('click', () => {
    if (playerState.playing) stopPlayback(); else startPlayback();
  });
  document.getElementById('btn-prev').addEventListener('click', skipPrev);
  document.getElementById('btn-next').addEventListener('click', skipNext);

  // Speed (controls Audio.playbackRate — no re-generation needed)
  document.getElementById('set-speed').addEventListener('input', e => {
    settings.rate = parseFloat(e.target.value);
    wordAudio.playbackRate = settings.rate;
    document.getElementById('speed-display').textContent = settings.rate.toFixed(1) + '×';
    save();
  });

  // Player-tab loop toggle
  document.getElementById('player-loop').addEventListener('change', e => {
    settings.autoLoop = e.target.checked; save();
  });

  // Word bank — add
  document.getElementById('btn-add-word').addEventListener('click', () => {
    const enEl = document.getElementById('inp-en');
    const esEl = document.getElementById('inp-es');
    const en = enEl.value.trim(), es = esEl.value.trim();
    if (!en || !es) { toast('Enter both English and Spanish'); return; }
    if (words.find(w => w.en.toLowerCase() === en.toLowerCase())) { toast('Word already exists'); return; }
    words.push({ en, es });
    save(); renderWordList(); buildDeck();
    enEl.value = ''; esEl.value = ''; enEl.focus();
    toast(`Added: ${en} → ${es}`);
    // Pre-cache the new word's audio in the background
    preloadWord({ en, es });
  });

  document.getElementById('inp-en').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('inp-es').focus();
  });
  document.getElementById('inp-es').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-add-word').click();
  });

  // Word bank — tap to play / delete
  document.getElementById('word-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const i = parseInt(del.dataset.del, 10);
      if (confirm(`Delete "${words[i].en}"?`)) {
        words.splice(i, 1); save(); renderWordList(); buildDeck();
        if (playerState.playing && playerState.index >= words.length) playerState.index = 0;
      }
      return;
    }
    const item = e.target.closest('[data-idx]');
    if (item) {
      stopPlayback();
      switchTab('player');
      startPlayback(parseInt(item.dataset.idx, 10));
    }
  });

  // Import / export
  document.getElementById('btn-export').addEventListener('click', exportWords);
  document.getElementById('btn-import').addEventListener('click', showImportModal);
  document.getElementById('btn-import-close').addEventListener('click', closeImportModal);
  document.getElementById('btn-import-do').addEventListener('click', doImport);
  document.getElementById('import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('import-file-name').textContent = file.name;
    const reader = new FileReader();
    reader.onload = ev => { document.getElementById('import-text').value = ev.target.result; };
    reader.readAsText(file);
  });
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    if (confirm('Delete ALL words? This cannot be undone.')) {
      words = []; save(); renderWordList(); buildDeck(); stopPlayback(); toast('Word bank cleared');
    }
  });

  // Flashcard
  document.getElementById('flashcard').addEventListener('click', () => {
    if (!flashState.revealed) fcReveal();
  });
  document.getElementById('btn-fc-wrong').addEventListener('click',  () => fcAnswer(false));
  document.getElementById('btn-fc-right').addEventListener('click',  () => fcAnswer(true));
  document.getElementById('btn-fc-speak').addEventListener('click',  () => {
    const w = flashState.deck[flashState.index];
    if (w) speak(w.en, 'en').then(() => delay(400)).then(() => speak(w.es, 'es'));
  });
  document.getElementById('btn-fc-shuffle').addEventListener('click', () => {
    buildDeck(); renderFlashcard(); toast('Deck reshuffled');
  });

  // Settings
  document.getElementById('btn-save-settings').addEventListener('click', applySettings);
  document.getElementById('btn-preload-all').addEventListener('click', () => {
    toast('Preloading audio…');
    preloadAll().then(() => toast('All audio clips cached'));
  });
  document.getElementById('install-btn').addEventListener('click', triggerInstall);
  ['set-loop', 'set-shuffle'].forEach(id =>
    document.getElementById(id).addEventListener('change', applySettings));

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }

  // Pre-cache all audio in the background after first paint
  requestAnimationFrame(() => preloadAll());
}

document.addEventListener('DOMContentLoaded', init);
