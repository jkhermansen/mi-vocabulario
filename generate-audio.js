#!/usr/bin/env node
// Runs in CI (Node 20+) to pre-generate OpenAI TTS clips for the default word list.
// Outputs to ./audio/{lang}-{slug}.mp3  (gitignored; uploaded to Pages by the workflow).
'use strict';

const fs   = require('fs');
const path = require('path');

const API_KEY = process.env.OPENAI_API_KEY;
const WORDS   = require('./words.json');
const OUT_DIR = path.join(__dirname, 'audio');

if (!API_KEY) {
  console.warn('OPENAI_API_KEY not set — skipping audio generation');
  process.exit(0);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// Must stay in sync with textSlug() in app.js
function textSlug(text) {
  return text.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function generateClip(text, lang, voice) {
  const slug     = textSlug(text);
  const filepath = path.join(OUT_DIR, `${lang}-${slug}.mp3`);

  if (fs.existsSync(filepath)) {
    console.log(`  skip  ${lang}/${text}`);
    return;
  }

  console.log(`  gen   ${lang}/${text} (${voice})…`);
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1-hd',
      input: text,
      voice,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    console.error(`  ERROR ${res.status} for "${text}": ${body}`);
    return;
  }

  const buf = await res.arrayBuffer();
  fs.writeFileSync(filepath, Buffer.from(buf));
  console.log(`  ok    ${filepath}`);
}

async function main() {
  console.log(`Generating TTS clips for ${WORDS.length} words…`);

  // Process 4 clips concurrently (2 words × 2 languages)
  const BATCH = 4;
  const tasks = WORDS.flatMap(w => [
    () => generateClip(w.en, 'en', 'alloy'),
    () => generateClip(w.es, 'es', 'alloy'),
  ]);

  for (let i = 0; i < tasks.length; i += BATCH) {
    await Promise.all(tasks.slice(i, i + BATCH).map(t => t()));
    // Small pause to stay within OpenAI rate limits
    if (i + BATCH < tasks.length) await new Promise(r => setTimeout(r, 300));
  }

  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
