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
  phase: 'idle',  // idle | english | pause | spanish | done
  playOrder: [],
};

let flashState = {
  index: 0,
  revealed: false,
  correct: 0,
  incorrect: 0,
  deck: [],
};

let synthQueue = [];
let synthBusy = false;
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

// ── TTS helpers ────────────────────────────────────────────────────────────
let voices = [];

function loadVoices() {
  voices = speechSynthesis.getVoices();
}

function pickVoice(lang) {
  if (!voices.length) loadVoices();
  return voices.find(v => v.lang.startsWith(lang) && !v.name.includes('Google') === false) ||
    voices.find(v => v.lang.startsWith(lang)) ||
    null;
}

function speak(text, lang, rate = settings.rate) {
  return new Promise(resolve => {
    // Cancel any pending speech
    speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang === 'en' ? 'en-US' : 'es-ES';
    utter.rate = rate;
    utter.pitch = 1;
    utter.volume = 1;

    const voice = lang === 'en'
      ? (settings.enVoice ? voices.find(v => v.name === settings.enVoice) : null) || pickVoice('en')
      : (settings.esVoice ? voices.find(v => v.name === settings.esVoice) : null) || pickVoice('es');

    if (voice) utter.voice = voice;

    utter.onend = () => resolve();
    utter.onerror = () => resolve();

    // Chrome mobile bug: synthesis stops if utterance is > ~15 words
    // Re-queue if synthesis gets stuck
    let watchdog = setTimeout(() => resolve(), (text.split(' ').length * 600 / rate) + 2000);
    utter.onend = () => { clearTimeout(watchdog); resolve(); };
    utter.onerror = () => { clearTimeout(watchdog); resolve(); };

    speechSynthesis.speak(utter);
  });
}

function delay(ms) {
  return new Promise(resolve => { deferTimer = setTimeout(resolve, ms); });
}

// ── Paul Noble playback engine ─────────────────────────────────────────────
async function playWord(wordObj) {
  if (!playerState.playing) return;

  const { en, es } = wordObj;

  // Phase: speak English
  playerState.phase = 'english';
  updatePlayerUI();
  showSpanish(false);
  await speak(en, 'en');
  if (!playerState.playing) return;

  // Phase: pause
  playerState.phase = 'pause';
  updatePlayerUI();
  await delay(settings.pauseMs);
  if (!playerState.playing) return;

  // Phase: speak Spanish (repeat N times)
  playerState.phase = 'spanish';
  showSpanish(true);
  updatePlayerUI();
  for (let i = 0; i < settings.repeatSpanish; i++) {
    await speak(es, 'es');
    if (!playerState.playing) return;
    if (i < settings.repeatSpanish - 1) {
      await delay(600);
      if (!playerState.playing) return;
    }
  }

  playerState.phase = 'done';
  updatePlayerUI();
  await delay(500);
}

async function runPlayback() {
  if (!words.length) { stopPlayback(); return; }

  buildPlayOrder();

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

    highlightWord(idx);
    await playWord(words[idx]);
    if (!playerState.playing) break;
    playerState.index++;
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

  speechSynthesis.cancel();
  if (deferTimer) clearTimeout(deferTimer);

  playerState.playing = true;
  if (fromIndex !== null) playerState.index = fromIndex;
  buildPlayOrder();

  updatePlayPauseBtn();
  setupMediaSession();
  startKeepAlive();
  runPlayback();
}

function stopPlayback() {
  playerState.playing = false;
  playerState.phase = 'idle';
  speechSynthesis.cancel();
  if (deferTimer) clearTimeout(deferTimer);
  stopKeepAlive();
  updatePlayPauseBtn();
  updatePlayerUI();
  showSpanish(false);
  highlightWord(-1);
}

function skipNext() {
  if (!playerState.playing) return;
  speechSynthesis.cancel();
  if (deferTimer) clearTimeout(deferTimer);
  playerState.index++;
  playerState.phase = 'idle';
}

function skipPrev() {
  if (!playerState.playing) return;
  speechSynthesis.cancel();
  if (deferTimer) clearTimeout(deferTimer);
  playerState.index = Math.max(0, playerState.index - 1);
  playerState.phase = 'idle';
}

// ── Media Session API ──────────────────────────────────────────────────────
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;

  const current = () => {
    const idx = playerState.playOrder[playerState.index];
    return idx !== undefined ? words[idx] : null;
  };

  const updateMeta = () => {
    const w = current();
    if (!w) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: w.en,
      artist: w.es,
      album: 'Mi Vocabulario',
      artwork: [
        { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ]
    });
  };

  navigator.mediaSession.setActionHandler('play', () => {
    if (!playerState.playing) startPlayback();
  });
  navigator.mediaSession.setActionHandler('pause', () => stopPlayback());
  navigator.mediaSession.setActionHandler('nexttrack', skipNext);
  navigator.mediaSession.setActionHandler('previoustrack', skipPrev);
  navigator.mediaSession.setActionHandler('stop', stopPlayback);

  navigator.mediaSession.playbackState = 'playing';
  updateMeta();
}

// Silent audio trick: keeps media session alive on Android lock screen
let silentAudio = null;
function ensureSilentAudio() {
  if (silentAudio) return;
  // 1-second silent MP3 as data URI (44-byte minimal MP3)
  const silentDataUri = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAABAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA//MUYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  silentAudio = new Audio(silentDataUri);
  silentAudio.loop = true;
}

function startKeepAlive() {
  ensureSilentAudio();
  silentAudio.play().catch(() => {});
  // Also ping service worker
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(() => {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      const chan = new MessageChannel();
      navigator.serviceWorker.controller.postMessage({ type: 'KEEP_ALIVE' }, [chan.port2]);
    }
  }, 25000);
}

function stopKeepAlive() {
  if (silentAudio) silentAudio.pause();
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

// ── UI Updates ─────────────────────────────────────────────────────────────
function updatePlayerUI() {
  const idx = playerState.playOrder[playerState.index];
  const word = idx !== undefined ? words[idx] : null;

  document.getElementById('player-english').textContent = word ? word.en : '—';
  document.getElementById('player-spanish').textContent = word ? word.es : '—';

  const total = words.length;
  const pos = playerState.index + 1;
  document.getElementById('progress-text').textContent =
    total ? `${Math.min(pos, total)} / ${total}` : '0 / 0';
  document.getElementById('progress-fill').style.width =
    total ? `${(Math.min(pos, total) / total) * 100}%` : '0%';

  const phaseLabels = {
    idle: '', english: 'Speaking English…', pause: 'Pause…',
    spanish: 'Speaking Spanish…', done: ''
  };
  document.getElementById('phase-label').textContent = phaseLabels[playerState.phase] || '';
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
    document.getElementById('fc-back').textContent = '';
    document.getElementById('fc-stats').textContent = '';
    return;
  }

  const w = flashState.deck[flashState.index];
  document.getElementById('fc-front').textContent = w ? w.en : '—';
  document.getElementById('fc-back').textContent = w ? w.es : '—';
  document.getElementById('fc-back').classList.toggle('show', flashState.revealed);

  const total = flashState.correct + flashState.incorrect;
  const pct = total ? Math.round((flashState.correct / total) * 100) : 0;
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
  const txt = words.map(w => `${w.en}\t${w.es}`).join('\n');
  const blob = new Blob([txt], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
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
      const en = parts[0].trim();
      const es = parts[1].trim();
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

  if (name === 'flashcard') {
    if (!flashState.deck.length) buildDeck();
    renderFlashcard();
  }
  if (name === 'settings') populateVoiceSelects();
  if (name === 'words') renderWordList();
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

// ── Settings apply ─────────────────────────────────────────────────────────
function applySettings() {
  settings.pauseMs = parseInt(document.getElementById('set-pause').value, 10) || 1500;
  settings.repeatSpanish = parseInt(document.getElementById('set-repeat').value, 10) || 2;
  settings.autoLoop = document.getElementById('set-loop').checked;
  settings.shufflePlayback = document.getElementById('set-shuffle').checked;
  settings.enVoice = document.getElementById('sel-en-voice').value;
  settings.esVoice = document.getElementById('sel-es-voice').value;
  save();
  toast('Settings saved');
}

function syncSettingsToUI() {
  document.getElementById('set-pause').value = settings.pauseMs;
  document.getElementById('set-repeat').value = settings.repeatSpanish;
  document.getElementById('set-loop').checked = settings.autoLoop;
  document.getElementById('set-shuffle').checked = settings.shufflePlayback;
  document.getElementById('set-speed').value = settings.rate;
  document.getElementById('speed-display').textContent = settings.rate.toFixed(1) + '×';
}

// ── Event wiring ───────────────────────────────────────────────────────────
function init() {
  load();
  renderWordList();
  buildDeck();
  updatePlayerUI();
  syncSettingsToUI();

  // Voices may load async
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = () => {
      loadVoices();
      populateVoiceSelects();
    };
  }
  loadVoices();

  // Tab bar
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Player controls
  document.getElementById('btn-play').addEventListener('click', () => {
    if (playerState.playing) stopPlayback();
    else startPlayback(playerState.index);
  });
  document.getElementById('btn-prev').addEventListener('click', skipPrev);
  document.getElementById('btn-next').addEventListener('click', skipNext);

  // Speed slider
  document.getElementById('set-speed').addEventListener('input', e => {
    settings.rate = parseFloat(e.target.value);
    document.getElementById('speed-display').textContent = settings.rate.toFixed(1) + '×';
    save();
  });

  // Loop toggle on player tab
  document.getElementById('player-loop').addEventListener('change', e => {
    settings.autoLoop = e.target.checked;
    save();
  });

  // Word bank
  document.getElementById('btn-add-word').addEventListener('click', () => {
    const enEl = document.getElementById('inp-en');
    const esEl = document.getElementById('inp-es');
    const en = enEl.value.trim();
    const es = esEl.value.trim();
    if (!en || !es) { toast('Enter both English and Spanish'); return; }
    if (words.find(w => w.en.toLowerCase() === en.toLowerCase())) {
      toast('Word already exists'); return;
    }
    words.push({ en, es });
    save();
    renderWordList();
    buildDeck();
    enEl.value = '';
    esEl.value = '';
    enEl.focus();
    toast(`Added: ${en} → ${es}`);
  });

  document.getElementById('inp-es').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-add-word').click();
  });
  document.getElementById('inp-en').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('inp-es').focus();
  });

  document.getElementById('word-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const i = parseInt(del.dataset.del, 10);
      if (confirm(`Delete "${words[i].en}"?`)) {
        words.splice(i, 1);
        save();
        renderWordList();
        buildDeck();
        if (playerState.playing && playerState.index >= words.length) {
          playerState.index = 0;
        }
      }
      return;
    }
    const item = e.target.closest('[data-idx]');
    if (item) {
      const i = parseInt(item.dataset.idx, 10);
      stopPlayback();
      playerState.index = i;
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
      words = [];
      save();
      renderWordList();
      buildDeck();
      stopPlayback();
      toast('Word bank cleared');
    }
  });

  // Flashcard
  document.getElementById('flashcard').addEventListener('click', () => {
    if (!flashState.revealed) fcReveal();
  });
  document.getElementById('btn-fc-wrong').addEventListener('click', () => fcAnswer(false));
  document.getElementById('btn-fc-right').addEventListener('click', () => fcAnswer(true));
  document.getElementById('btn-fc-speak').addEventListener('click', () => {
    const w = flashState.deck[flashState.index];
    if (w) { speak(w.en, 'en').then(() => delay(400)).then(() => speak(w.es, 'es')); }
  });
  document.getElementById('btn-fc-shuffle').addEventListener('click', () => {
    buildDeck();
    renderFlashcard();
    toast('Deck reshuffled');
  });

  // Settings
  document.getElementById('btn-save-settings').addEventListener('click', applySettings);
  document.getElementById('install-btn').addEventListener('click', triggerInstall);

  // Add load event for settings tab auto-save on change for toggles
  ['set-loop', 'set-shuffle'].forEach(id => {
    document.getElementById(id).addEventListener('change', applySettings);
  });

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
}

document.addEventListener('DOMContentLoaded', init);
