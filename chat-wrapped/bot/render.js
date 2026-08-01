// Renders a deck (from deck.js) into a Telegram HTML message.
// Same cards as the web story player — text instead of story cards, because
// that is what pastes back into a group chat.

import { esc } from './telegram.js';

const MEDAL = ['🥇', '🥈', '🥉', '4.', '5.', '6.'];

function bar(pct, width = 12) {
  const filled = Math.max(1, Math.round((pct / 100) * width));
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function card(c) {
  const line = c.line ? `\n<i>${esc(c.line)}</i>` : '';

  switch (c.kind) {
    case 'intro':
      return `🏆 <b>${esc((c.title || '').replace(/\n/g, ' '))}</b>\n<i>${esc(c.eyebrow)}</i>${line}`;

    case 'verdict':
      return `🎬 <b>${esc(c.title)}</b>${line}`;

    case 'bignumber':
      return `${esc(c.eyebrow)}\n<b>${esc(c.value)}</b> ${esc(c.unit)}${line}`;

    case 'award':
      return `🏅 <b>${esc(c.award)}</b>\n<b>${esc(c.person)}</b>${
        c.stat ? ` — ${esc(c.stat)}` : ''
      }${line}`;

    case 'leaderboard': {
      const rows = c.rows
        .map(
          (r, i) =>
            `${MEDAL[i] || `${i + 1}.`} <b>${esc(r.name)}</b>  ${bar(r.pct)} ${r.pct}% · ${esc(
              r.value
            )}`
        )
        .join('\n');
      return `📊 <b>${esc(c.title)}</b>\n${rows}${line}`;
    }

    case 'chart':
      return `🕐 <b>${esc(c.title)}</b>${line}`;

    case 'emoji': {
      const row = c.emojis.map((e) => `${e.emoji} ${e.count}`).join('   ');
      return `${esc(c.eyebrow)}\n${row}${line}`;
    }

    case 'words': {
      const row = c.words.map((w) => `${esc(w.word)} (${w.count})`).join(' · ');
      return `💬 <b>${esc(c.eyebrow)}</b>\n${row}${line}`;
    }

    case 'versus':
      return `⚡ <b>${esc(c.eyebrow)}</b>\n${esc(c.left.label)}: <b>${esc(
        c.left.name
      )}</b> — ${esc(c.left.value)}\n${esc(c.right.label)}: <b>${esc(c.right.name)}</b> — ${esc(
        c.right.value
      )}${line}`;

    case 'share':
      return c.stats.map((s) => `${esc(s.k)}: <b>${esc(s.v)}</b>`).join('\n');

    default:
      return null;
  }
}

export function renderDeck(deck) {
  return deck
    .map(card)
    .filter(Boolean)
    .join('\n\n');
}
