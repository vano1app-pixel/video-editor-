// Minimal Telegram Bot API client — long polling, no dependencies.

// Overridable so the bot can be pointed at a local stub in tests, or at a
// self-hosted Bot API server.
const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`${method} failed (${code}): ${description}`);
    this.name = 'TelegramError';
    this.code = code;
  }
}

export class Telegram {
  constructor(token) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required.');
    this.token = token;
    this.base = `${API}/bot${token}`;
  }

  async call(method, params = {}, { timeoutMs = 70_000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        throw new TelegramError(method, data.error_code ?? res.status, data.description ?? 'unknown');
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  getMe() {
    return this.call('getMe', {}, { timeoutMs: 15_000 });
  }

  /** Long poll. `timeout` is the server-side hold in seconds. */
  getUpdates(offset, timeout = 50) {
    return this.call(
      'getUpdates',
      {
        offset,
        timeout,
        allowed_updates: ['message', 'my_chat_member'],
      },
      { timeoutMs: (timeout + 20) * 1000 }
    );
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...extra,
      },
      { timeoutMs: 20_000 }
    );
  }

  /** Telegram caps a message at 4096 characters — send in order, never merged. */
  async sendLong(chatId, text, extra = {}) {
    for (const chunk of splitForTelegram(text)) {
      await this.sendMessage(chatId, chunk, extra);
    }
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands }, { timeoutMs: 15_000 });
  }
}

const LIMIT = 4000; // under 4096, leaving room for entity overhead

/** Split on blank lines first, then newlines, then hard-cut. Never mid-tag. */
export function splitForTelegram(text, limit = LIMIT) {
  if (text.length <= limit) return [text];
  const out = [];
  let buf = '';

  const flush = () => {
    if (buf.trim()) out.push(buf.trimEnd());
    buf = '';
  };

  for (const block of text.split('\n\n')) {
    const piece = block + '\n\n';
    if (buf.length + piece.length <= limit) {
      buf += piece;
      continue;
    }
    flush();
    if (piece.length <= limit) {
      buf = piece;
      continue;
    }
    // A single oversized block: break it on lines, then characters.
    let line = '';
    for (const l of piece.split('\n')) {
      if (line.length + l.length + 1 > limit) {
        if (line) out.push(line.trimEnd());
        line = '';
        while (l.length > limit) {
          out.push(l.slice(0, limit));
          line = l.slice(limit);
        }
        if (!line) line = '';
      }
      line += (line ? '\n' : '') + l;
    }
    buf = line;
  }
  flush();
  return out;
}

/** Escape for parse_mode: HTML. Telegram only needs these three. */
export function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
