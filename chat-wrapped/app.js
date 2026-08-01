import { parseChat, windowMessages } from './parser.js';
import { computeStats, buildAiPayload } from './stats.js';
import { buildDeck } from './deck.js';
import { generateCopy } from './ai.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  messages: [],
  windowDays: 30,
  tone: 'balanced',
  deck: [],
  cursor: 0,
  timer: null,
  paused: false,
};

const WINDOWS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 365, label: 'Last year' },
  { days: 0, label: 'All time' },
];

const CARD_MS = 6200;

/* ---------------- Landing ---------------- */

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('err', isError);
}

function renderChips() {
  const wrap = $('#windows');
  wrap.innerHTML = '';
  for (const w of WINDOWS) {
    const b = document.createElement('button');
    b.className = 'chip' + (w.days === state.windowDays ? ' on' : '');
    b.textContent = w.label;
    b.onclick = () => {
      state.windowDays = w.days;
      renderChips();
      if (state.messages.length) describeSelection();
    };
    wrap.appendChild(b);
  }

  const tones = $('#tones');
  tones.innerHTML = '';
  for (const t of ['gentle', 'balanced', 'brutal']) {
    const b = document.createElement('button');
    b.className = 'chip' + (t === state.tone ? ' on' : '');
    b.textContent = t;
    b.onclick = () => {
      state.tone = t;
      renderChips();
    };
    tones.appendChild(b);
  }
}

function describeSelection() {
  const slice = windowMessages(state.messages, state.windowDays);
  const label = WINDOWS.find((w) => w.days === state.windowDays).label;
  if (!slice.length) {
    setStatus(`No messages in "${label}". Try a wider window.`, true);
    $('#go').disabled = true;
    return;
  }
  const people = new Set(slice.map((m) => m.author)).size;
  setStatus(`${slice.length.toLocaleString()} messages · ${people} people · ${label}`);
  $('#go').disabled = false;
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) {
    setStatus('That file is over 60MB. Export a shorter window from WhatsApp.', true);
    return;
  }
  setStatus('Reading…');
  try {
    const raw = await file.text();
    // Locale only breaks ties — unambiguous or non-chronological dates win.
    const preferMonthFirst = /^en-US\b/i.test(navigator.language || '');
    const parsed = parseChat(raw, file.name.toLowerCase(), { preferMonthFirst });

    if (!parsed.messages.length) {
      setStatus(
        'No messages found. Make sure this is the .txt from "Export chat" (not the .zip).',
        true
      );
      return;
    }
    if (parsed.messages.length < 25) {
      setStatus(
        `Only ${parsed.messages.length} messages found. If this group uses disappearing messages, there is nothing to recap.`,
        true
      );
    }

    state.messages = parsed.messages;
    $('#dropTitle').textContent = file.name;
    describeSelection();
  } catch (err) {
    console.error(err);
    setStatus('Could not read that file.', true);
  }
}

async function run() {
  const slice = windowMessages(state.messages, state.windowDays);
  const stats = computeStats(slice);
  if (!stats) {
    setStatus('Not enough to work with in that window.', true);
    return;
  }

  const label = WINDOWS.find((w) => w.days === state.windowDays).label;
  $('#go').disabled = true;
  $('#spinner').classList.remove('hidden');

  let ai = null;
  const key = $('#apikey').value.trim();
  try {
    setStatus('Writing your awards…');
    ai = await generateCopy(buildAiPayload(stats, slice), { apiKey: key || undefined, tone: state.tone });
  } catch (err) {
    console.error(err);
    setStatus(`${err.message} — showing the stats-only version.`, true);
  }

  $('#spinner').classList.add('hidden');
  $('#go').disabled = false;

  state.deck = buildDeck(stats, ai, label);
  openPlayer();
}

/* ---------------- Story player ---------------- */

function openPlayer() {
  state.cursor = 0;
  $('#player').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  paint();
}

function closePlayer() {
  clearTimeout(state.timer);
  $('#player').classList.add('hidden');
  document.body.style.overflow = '';
}

function go(delta) {
  const next = state.cursor + delta;
  if (next < 0) return;
  if (next >= state.deck.length) {
    closePlayer();
    return;
  }
  state.cursor = next;
  paint();
}

function paint() {
  const card = state.deck[state.cursor];
  const stage = $('#stage');
  stage.style.background = card.palette.bg;

  $('#cardHost').innerHTML = renderCard(card);
  $('#cardHost').className = 'card enter';

  const prog = $('#progress');
  prog.innerHTML = '';
  for (let i = 0; i < state.deck.length; i++) {
    const seg = document.createElement('i');
    if (i < state.cursor) seg.className = 'done';
    if (i === state.cursor && !state.paused) {
      seg.className = 'now';
      seg.style.setProperty('--dur', `${CARD_MS}ms`);
    }
    if (i === state.cursor && state.paused) seg.className = 'done';
    prog.appendChild(seg);
  }

  clearTimeout(state.timer);
  if (!state.paused) state.timer = setTimeout(() => go(1), CARD_MS);
}

function esc(str = '') {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function renderCard(c) {
  const eyebrow = `<div class="eyebrow">${esc(c.eyebrow || '')}</div>`;
  const line = c.line ? `<div class="line">${esc(c.line)}</div>` : '';

  switch (c.kind) {
    case 'intro':
    case 'verdict':
      return `${eyebrow}<div class="headline">${esc(c.title)}</div>${line}`;

    case 'bignumber':
      return `${eyebrow}<div class="bignum">${esc(c.value)}</div><div class="unit">${esc(
        c.unit
      )}</div>${line}`;

    case 'award':
      return `${eyebrow}<div class="awardname">${esc(c.award)}</div><div class="person">${esc(
        c.person
      )}</div><div class="stat">${esc(c.stat)}</div>${line}`;

    case 'leaderboard': {
      const max = Math.max(...c.rows.map((r) => r.pct), 1);
      const rows = c.rows
        .map(
          (r, i) => `<div class="row"><span>${i + 1}</span>
        <span class="rowline"><span class="who">${esc(r.name)} · ${r.pct}%</span>
        <span class="bar"><i style="width:${Math.round((r.pct / max) * 100)}%"></i></span></span>
        <span>${esc(r.value)}</span></div>`
        )
        .join('');
      return `${eyebrow}<div class="headline">${esc(
        c.title
      )}</div><div class="rows">${rows}</div>${line}`;
    }

    case 'chart': {
      const max = Math.max(...c.bars, 1);
      const bars = c.bars
        .map(
          (v, i) =>
            `<i style="height:${Math.max(3, Math.round((v / max) * 100))}%;animation-delay:${
              i * 12
            }ms"></i>`
        )
        .join('');
      return `${eyebrow}<div class="headline">${esc(
        c.title
      )}</div><div class="chartwrap">${bars}</div>${line}`;
    }

    case 'emoji': {
      const grid = c.emojis
        .map((e) => `<div><div class="e">${esc(e.emoji)}</div><div class="c">${e.count}</div></div>`)
        .join('');
      return `${eyebrow}<div class="emojigrid">${grid}</div>${line}`;
    }

    case 'words': {
      const max = c.words[0].count || 1;
      const cloud = c.words
        .map((w) => {
          const size = 20 + Math.round((w.count / max) * 30);
          return `<span style="font-size:${size}px">${esc(w.word)}</span>`;
        })
        .join('');
      return `${eyebrow}<div class="wordcloud">${cloud}</div>${line}`;
    }

    case 'versus':
      return `${eyebrow}<div class="versus">
        <div class="vs"><div class="lbl">${esc(c.left.label)}</div><div class="nm">${esc(
          c.left.name
        )}</div><div class="vl">${esc(c.left.value)}</div></div>
        <div class="vs"><div class="lbl">${esc(c.right.label)}</div><div class="nm">${esc(
          c.right.name
        )}</div><div class="vl">${esc(c.right.value)}</div></div>
      </div>${line}`;

    case 'share': {
      const grid = c.stats
        .map((s) => `<div><div class="k">${esc(s.k)}</div><div class="v">${esc(s.v)}</div></div>`)
        .join('');
      return `${eyebrow}<div class="headline">${esc(
        c.title
      )}</div><div class="sharegrid">${grid}</div>${line}`;
    }

    default:
      return `${eyebrow}${line}`;
  }
}

/* ---------------- Share image ---------------- */

async function saveCard() {
  const c = state.deck[state.cursor];
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Approximate the CSS gradient with its two stops.
  const stops = c.palette.bg.match(/#[0-9a-f]{6}/gi) || ['#1DB954', '#0b6b31'];
  const grad = ctx.createLinearGradient(0, 0, W * 0.4, H);
  grad.addColorStop(0, stops[0]);
  grad.addColorStop(1, stops[1] || stops[0]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';

  const pad = 96;
  let y = 420;

  const write = (text, size, weight, gap, alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.font = `${weight} ${size}px Inter, Helvetica, Arial, sans-serif`;
    for (const l of wrap(ctx, String(text), W - pad * 2)) {
      ctx.fillText(l, pad, y);
      y += size * 1.08;
    }
    y += gap;
    ctx.globalAlpha = 1;
  };

  write((c.eyebrow || '').toUpperCase(), 34, '800', 26, 0.75);

  if (c.kind === 'award') {
    write(c.award, 72, '900', 12);
    write(c.person, 132, '900', 18);
    write(c.stat, 44, '700', 26, 0.9);
  } else if (c.kind === 'bignumber') {
    write(c.value, 190, '900', 6);
    write(c.unit, 52, '700', 26, 0.9);
  } else if (c.kind === 'share') {
    write(c.title, 104, '900', 30);
    for (const s of c.stats) {
      write(`${s.k.toUpperCase()}  ${s.v}`, 48, '800', 12, 0.92);
    }
    y += 14;
  } else if (c.title) {
    write(c.title.replace(/\n/g, ' '), 104, '900', 26);
  }

  if (c.line) write(c.line, 46, '600', 0, 0.94);

  ctx.globalAlpha = 0.6;
  ctx.font = '800 30px Inter, Helvetica, Arial, sans-serif';
  ctx.fillText('CHAT WRAPPED', pad, H - 140);
  ctx.globalAlpha = 1;

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) return;

  const file = new File([blob], 'chat-wrapped.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Chat Wrapped' });
      return;
    } catch {
      /* user cancelled — fall through to download */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-wrapped-${c.id}.png`;
  a.click();
  URL.revokeObjectURL(url);
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/* ---------------- Wiring ---------------- */

function init() {
  renderChips();

  const drop = $('#drop');
  const input = $('#file');

  $('#pick').onclick = () => input.click();
  input.onchange = () => handleFile(input.files[0]);

  ['dragenter', 'dragover'].forEach((e) =>
    drop.addEventListener(e, (ev) => {
      ev.preventDefault();
      drop.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((e) =>
    drop.addEventListener(e, (ev) => {
      ev.preventDefault();
      drop.classList.remove('drag');
    })
  );
  drop.addEventListener('drop', (ev) => handleFile(ev.dataTransfer.files[0]));

  $('#go').onclick = run;

  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#close').onclick = closePlayer;
  $('#save').onclick = saveCard;
  $('#pause').onclick = () => {
    state.paused = !state.paused;
    $('#pause').textContent = state.paused ? '▶ Play' : '❚❚ Pause';
    paint();
  };

  document.addEventListener('keydown', (e) => {
    if ($('#player').classList.contains('hidden')) return;
    if (e.key === 'ArrowRight' || e.key === ' ') go(1);
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'Escape') closePlayer();
  });

  const saved = localStorage.getItem('cw_key');
  if (saved) $('#apikey').value = saved;
  $('#apikey').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v) localStorage.setItem('cw_key', v);
    else localStorage.removeItem('cw_key');
  });
}

init();
