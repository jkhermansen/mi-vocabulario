'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const DEFAULT_WORDS = [
  { en: 'hello', es: 'hola' },
  { en: 'thank you', es: 'gracias' },
  { en: 'please', es: 'por favor' },
  { en: 'goodbye', es: 'adiós' },
  { en: 'yes', es: 'sí' },
  { en: 'no', es: 'no' },
  { en: 'water', es: 'agua' },
  { en: 'food', es: 'comida' },
  { en: 'where is', es: 'dónde está' },
  { en: 'how much', es: 'cuánto cuesta' },
];

let words = [];
let settings = {
  pauseMs: 1500,
  repeatSpanish: 2,
  rate: 1.0,
  autoLoop: true,
  enVoice: '',
  esVoice: '',
  shufflePlayback: false,
};

let playerState = {
  playing: false,
  index: 0,
  phase: 'idle',      // idle | english | pause | spanish | done
  playOrder: [],
  generation: 0,      // incremented on skip/stop so in-flight playWord exits early
};

let flashState = {
  index: 0,
  revealed: false,
  correct: 0,
  incorrect: 0,
  deck: [],
};

let keepAliveInterval = null;
let deferTimer = null;

// ── Persistence ────────────────────────────────────────────────────────────
function save() {
  localStorage.setItem('mv_words', JSON.stringify(words));
  localStorage.setItem('mv_settings', JSON.stringify(settings));
}

function load() {
  try {
    const w = localStorage.getItem('mv_words');
    words = w ? JSON.parse(w) : [...DEFAULT_WORDS];
    const s = localStorage.getItem('mv_settings');
    if (s) Object.assign(settings, JSON.parse(s));
  } catch {
    words = [...DEFAULT_WORDS];
  }
}

// ── Silent audio — keeps Android audio session alive ───────────────────────
// Generates a real WAV blob rather than relying on a fragile data URI.
let silentAudio = null;

function makeSilentWavUrl(durationSeconds = 3, sampleRate = 8000) {
  const numSamples = sampleRate * durationSeconds;
  const buf = new ArrayBuffer(44 + numSamples);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0,  'RIFF');  v.setUint32(4,  36 + numSamples, true);
  str(8,  'WAVE');
  str(12, 'fmt ');  v.setUint32(16, 16,         true);
                    v.setUint16(20, 1,           true); // PCM
                    v.setUint16(22, 1,           true); // mono
                    v.setUint32(24, sampleRate,  true);
                    v.setUint32(28, sampleRate,  true); // byte rate
                    v.setUint16(32, 1,           true); // block align
                    v.setUint16(34, 8,           true); // 8-bit
  str(36, 'data');  v.setUint32(40, numSamples,  true);
  // 8-bit PCM silence = 128 (unsigned midpoint), not 0
  for (let i = 44; i < 44 + numSamples; i++) v.setUint8(i, 128);

  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function ensureSilentAudio() {
  if (silentAudio) return;
  silentAudio = new Audio(makeSilentWavUrl());
  silentAudio.loop = true;
  silentAudio.volume = 0.001; // near-zero but non-zero keeps the session truly alive
}

function startKeepAlive() {
  ensureSilentAudio();
  silentAudio.play().catch(() => {});

  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(() => {
    // Chrome Android suspends speechSynthesis in the background after ~15 s.
    // Calling resume() periodically prevents that.
    if (speechSynthesis.paused || speechSynthesis.pending) {
      speechSynthesis.resume();
    }
    // Ping service worker to keep it alive
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      const chan = new MessageChannel();
      navigator.serviceWorker.controller.postMessage({ type: 'KEEP_ALIVE' }, [chan.port2]);
    }
  }, 10000);
}

function stopKeepAlive() {
  if (silentAudio) silentAudio.pause();
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

// ── TTS helpers ────────────────────────────────────────────────────────────
let voices = [];

function loadVoices() {
  voices = speechSynthesis.getVoices();
}

function pickVoice(lang) {
  if (!voices.length) loadVoices();
  // Prefer non-Google voices on Android — they are the on-device voices
  // and continue to work when the screen is locked. Google voices require
  // a network round-trip that Android blocks in the background.
  return voices.find(v => v.lang.startsWith(lang) && !v.name.includes('Google')) ||
    voices.find(v => v.lang.startsWith(lang)) ||
    null;
}

function speak(text, lang) {
  return new Promise(resolve => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang  = lang === 'en' ? 'en-US' : 'es-ES';
    utter.rate  = settings.rate;
    utter.pitch = 1;
    utter.volume = 1;

    const voice = lang === 'en'
      ? (settings.enVoice ? voices.find(v => v.name === settings.enVoice) : null) || pickVoice('en')
      : (settings.esVoice ? voices.find(v => v.name === settings.esVoice) : null) || pickVoice('es');
    if (voice) utter.voice = voice;

    // Watchdog: Chrome mobile sometimes fires neither onend nor onerror
    const wordCount = text.trim().split(/\s+/).length;
    const watchdogMs = Math.ceil(wordCount * 700 / settings.rate) + 3000;
    const watchdog = setTimeout(() => resolve(), watchdogMs);

    utter.onend   = () => { clearTimeout(watchdog); resolve(); };
    // 'interrupted' = we cancelled it intentionally (skip/stop) — still resolve
    utter.onerror = () => { clearTimeout(watchdog); resolve(); };

    // Resume in case Android paused synthesis while backgrounded
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.speak(utter);
  });
}

function delay(ms) {
  return new Promise(resolve => { deferTimer = setTimeout(resolve, ms); });
}

// ── Paul Noble playback engine ─────────────────────────────────────────────
// `gen` is a snapshot of playerState.generation at the moment playWord was
// called. If it changes (skip/stop), we bail out immediately after each await.
async function playWord(wordObj, gen) {
  const bail = () => playerState.generation !== gen || !playerState.playing;

  const { en, es } = wordObj;

  // English
  playerState.phase = 'english';
  updatePlayerUI();
  showSpanish(false);
  await speak(en, 'en');
  if (bail()) return;

  // Pause
  playerState.phase = 'pause';
  updatePlayerUI();
  await delay(settings.pauseMs);
  if (bail()) return;

  // Spanish × N
  playerState.phase = 'spanish';
  showSpanish(true);
  updatePlayerUI();
  for (let i = 0; i < settings.repeatSpanish; i++) {
    await speak(es, 'es');
    if (bail()) return;
    if (i < settings.repeatSpanish - 1) {
      await delay(600);
      if (bail()) return;
    }
  }

  playerState.phase = 'done';
  updatePlayerUI();
  await delay(500);
}

async function runPlayback() {
  if (!words.length) { stopPlayback(); return; }

  while (playerState.playing) {
    const idx = playerState.playOrder[playerState.index];

    if (idx === undefined) {
      if (settings.autoLoop) {
        playerState.index = 0;
        buildPlayOrder();
        continue;
      } else {
        stopPlayback();
        break;
      }
    }

    const gen = playerState.generation;
    highlightWord(idx);
    updateMediaSessionMeta(words[idx]);
    await playWord(words[idx], gen);

    if (!playerState.playing) break;

    // If a skip happened, generation changed — don't auto-advance;
    // the skip function already set the correct index.
    if (playerState.generation === gen) {
      playerState.index++;
    }
  }
}

function buildPlayOrder() {
  const order = words.map((_, i) => i);
  if (settings.shufflePlayback) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  playerState.playOrder = order;
}

function startPlayback(fromIndex = null) {
  if (!words.length) { toast('Add some words first!'); return; }

  // Cancel any in-flight speech first, then bump generation so playWord exits
  speechSynthesis.cancel();
  if (deferTimer) clearTimeout(deferTimer);
  playerState.generation++;

  playerState.playing = true;
  if (fromIndex !== null) playerState.index = fromIndex;
  buildPlayOrder();

  updatePlayPauseBtn();
  setupMediaSession();
  startKeepAlive();
  runPlayback();
}

function stopPlayback() {
  playerState.generation++;   // causes any in-flight playWord to bail
  playerState.playing = false;
  playerState.phase = 'idle';
  speechSynthesis.cancel();
  if (deferTimer) clearTimeout(deferTimer);
  stopKeepAlive();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  updatePlayPauseBtn();
  updatePlayerUI();
  showSpanish(false);
  highlightWord(-1);
}

function skipNext() {
  if (!playerState.playing) return;
  playerState.generation++;   // playWord will bail after its current await
  playerState.index++;
  speechSynthesis.cancel();
  if (deferTimer) clearTimeout(deferTimer);
  // runPlayback sees generation changed, skips auto-advance, loops to new index
}

function skipPrev() {
  if (!playerState.playing) return;
  playerState.generation++;
  playerState.index = Math.max(0, playerState.index - 1);
  speechSynthesis.cancel();
  if (deferTimer) clearTimeout(deferTimer);
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
    title:  word.en,
    artist: word.es,
    album:  'Mi Vocabulario',
    artwork: [
      { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ]
  });
  navigator.mediaSession.playbackState = 'playing';
}

// Resume synthesis if the app returns to the foreground after being backgrounded
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playerState.playing) {
    if (speechSynthesis.paused) speechSynthesis.resume();
  }
});

// ── UI Updates ─────────────────────────────────────────────────────────────
function updatePlayerUI() {
  const idx  = playerState.playOrder[playerState.index];
  const word = idx !== undefined ? words[idx] : null;

  document.getElementById('player-english').textContent = word ? word.en : '—';
  document.getElementById('player-spanish').textContent = word ? word.es : '—';

  const total = words.length;
  const pos   = playerState.index + 1;
  document.getElementById('progress-text').textContent =
    total ? `${Math.min(pos, total)} / ${total}` : '0 / 0';
  document.getElementById('progress-fill').style.width =
    total ? `${(Math.min(pos, total) / total) * 100}%` : '0%';

  const labels = { idle: '', english: 'Speaking English…', pause: 'Pause…', spanish: 'Speaking Spanish…', done: '' };
  document.getElementById('phase-label').textContent = labels[playerState.phase] || '';
}

function showSpanish(show) {
  document.getElementById('player-spanish').classList.toggle('visible', show);
}

function updatePlayPauseBtn() {
  document.getElementById('btn-play').textContent = playerState.playing ? '⏸' : '▶';
}

function highlightWord(idx) {
  document.querySelectorAll('.word-item').forEach((el, i) => {
    el.classList.toggle('playing', i === idx);
  });
  if (idx >= 0) {
    const el = document.querySelectorAll('.word-item')[idx];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    <div class="word-item" data-idx="${i}">
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
  flashState.deck = [...words].sort(() => Math.random() - 0.5);
  flashState.index = 0;
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

// ── Voice selector ─────────────────────────────────────────────────────────
function populateVoiceSelects() {
  loadVoices();
  const enSel = document.getElementById('sel-en-voice');
  const esSel = document.getElementById('sel-es-voice');
  if (!enSel || !esSel) return;

  const enVoices = voices.filter(v => v.lang.startsWith('en'));
  const esVoices = voices.filter(v => v.lang.startsWith('es'));

  enSel.innerHTML = '<option value="">Default</option>' +
    enVoices.map(v => `<option value="${escHtml(v.name)}" ${settings.enVoice===v.name?'selected':''}>${escHtml(v.name)}</option>`).join('');
  esSel.innerHTML = '<option value="">Default</option>' +
    esVoices.map(v => `<option value="${escHtml(v.name)}" ${settings.esVoice===v.name?'selected':''}>${escHtml(v.name)}</option>`).join('');
}

// ── Import / Export ────────────────────────────────────────────────────────
function exportWords() {
  const txt  = words.map(w => `${w.en}\t${w.es}`).join('\n');
  const blob = new Blob([txt], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'vocabulario.txt';
  a.click();
}

function showImportModal() {
  document.getElementById('import-modal').classList.add('open');
  document.getElementById('import-text').value = '';
  document.getElementById('import-text').focus();
}

function closeImportModal() {
  document.getElementById('import-modal').classList.remove('open');
}

function doImport() {
  const txt = document.getElementById('import-text').value.trim();
  if (!txt) { closeImportModal(); return; }

  let added = 0;
  txt.split('\n').forEach(line => {
    const parts = line.split('\t');
    if (parts.length >= 2) {
      const en = parts[0].trim(), es = parts[1].trim();
      if (en && es && !words.find(w => w.en.toLowerCase() === en.toLowerCase())) {
        words.push({ en, es });
        added++;
      }
    }
  });

  save();
  renderWordList();
  buildDeck();
  closeImportModal();
  toast(`Imported ${added} word${added !== 1 ? 's' : ''}`);
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
  if (name === 'settings')  populateVoiceSelects();
  if (name === 'words')     renderWordList();
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Settings ───────────────────────────────────────────────────────────────
function applySettings() {
  settings.pauseMs       = parseInt(document.getElementById('set-pause').value,  10) || 1500;
  settings.repeatSpanish = parseInt(document.getElementById('set-repeat').value, 10) || 2;
  settings.autoLoop      = document.getElementById('set-loop').checked;
  settings.shufflePlayback = document.getElementById('set-shuffle').checked;
  settings.enVoice       = document.getElementById('sel-en-voice').value;
  settings.esVoice       = document.getElementById('sel-es-voice').value;
  save();
  toast('Settings saved');
}

function syncSettingsToUI() {
  document.getElementById('set-pause').value   = settings.pauseMs;
  document.getElementById('set-repeat').value  = settings.repeatSpanish;
  document.getElementById('set-loop').checked  = settings.autoLoop;
  document.getElementById('set-shuffle').checked = settings.shufflePlayback;
  document.getElementById('set-speed').value   = settings.rate;
  document.getElementById('speed-display').textContent = settings.rate.toFixed(1) + '×';
}

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  load();
  renderWordList();
  buildDeck();
  updatePlayerUI();
  syncSettingsToUI();

  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = () => { loadVoices(); populateVoiceSelects(); };
  }
  loadVoices();

  // Tab bar
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // Player
  document.getElementById('btn-play').addEventListener('click', () => {
    if (playerState.playing) stopPlayback();
    else startPlayback(playerState.index);
  });
  document.getElementById('btn-prev').addEventListener('click', skipPrev);
  document.getElementById('btn-next').addEventListener('click', skipNext);

  // Speed
  document.getElementById('set-speed').addEventListener('input', e => {
    settings.rate = parseFloat(e.target.value);
    document.getElementById('speed-display').textContent = settings.rate.toFixed(1) + '×';
    save();
  });

  // Player-tab loop toggle
  document.getElementById('player-loop').addEventListener('change', e => {
    settings.autoLoop = e.target.checked;
    save();
  });

  // Word bank
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
  });
  document.getElementById('inp-en').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('inp-es').focus(); });
  document.getElementById('inp-es').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('btn-add-word').click(); });

  document.getElementById('word-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const i = parseInt(del.dataset.del, 10);
      if (confirm(`Delete "${words[i].en}"?`)) {
        words.splice(i, 1);
        save(); renderWordList(); buildDeck();
        if (playerState.playing && playerState.index >= words.length) playerState.index = 0;
      }
      return;
    }
    const item = e.target.closest('[data-idx]');
    if (item) {
      const i = parseInt(item.dataset.idx, 10);
      stopPlayback();
      switchTab('player');
      startPlayback(i);
    }
  });

  // Import / Export
  document.getElementById('btn-export').addEventListener('click', exportWords);
  document.getElementById('btn-import').addEventListener('click', showImportModal);
  document.getElementById('btn-import-close').addEventListener('click', closeImportModal);
  document.getElementById('btn-import-do').addEventListener('click', doImport);
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    if (confirm('Delete ALL words? This cannot be undone.')) {
      words = []; save(); renderWordList(); buildDeck(); stopPlayback(); toast('Word bank cleared');
    }
  });

  // Flashcard
  document.getElementById('flashcard').addEventListener('click', () => { if (!flashState.revealed) fcReveal(); });
  document.getElementById('btn-fc-wrong').addEventListener('click', () => fcAnswer(false));
  document.getElementById('btn-fc-right').addEventListener('click', () => fcAnswer(true));
  document.getElementById('btn-fc-speak').addEventListener('click', () => {
    const w = flashState.deck[flashState.index];
    if (w) speak(w.en, 'en').then(() => delay(400)).then(() => speak(w.es, 'es'));
  });
  document.getElementById('btn-fc-shuffle').addEventListener('click', () => { buildDeck(); renderFlashcard(); toast('Deck reshuffled'); });

  // Settings
  document.getElementById('btn-save-settings').addEventListener('click', applySettings);
  document.getElementById('install-btn').addEventListener('click', triggerInstall);
  ['set-loop', 'set-shuffle'].forEach(id =>
    document.getElementById(id).addEventListener('change', applySettings));

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
}

document.addEventListener('DOMContentLoaded', init);
