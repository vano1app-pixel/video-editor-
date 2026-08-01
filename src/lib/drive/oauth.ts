import fs from "node:fs";
import path from "node:path";

import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_SCOPES,
  PATHS,
  driveConfigured,
  ensureStorageDirs,
} from "@/lib/config";

/**
 * Google OAuth token lifecycle for Drive import.
 *
 * Plain fetch against Google's REST endpoints — no SDK. EditAi is a single-user
 * local app, so exactly one token set exists at a time: it lives on a
 * `globalThis` singleton (route modules are re-evaluated constantly in dev) and
 * is mirrored to `storage/drive-tokens.json` with 0600 so a restart does not
 * force the user to re-authorise.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Treat a token as expired a minute early so an in-flight call cannot race it. */
const EXPIRY_SLACK_MS = 60_000;

/** Backoff for retryable (429/5xx/network) token requests. */
const RETRY_DELAYS_MS = [500, 1500];

const TOKENS_FILE = "drive-tokens.json";

export interface DriveTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: number;
  scope: string;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

interface OAuthState {
  tokens: DriveTokens | null;
  /** True once disk has been consulted, so a missing file is not re-read. */
  loaded: boolean;
  /** In-flight refresh, so parallel requests share one round trip. */
  refreshing: Promise<string | null> | null;
}

const GLOBAL_KEY = "__editai_drive_oauth";

type GlobalWithOAuth = typeof globalThis & {
  [GLOBAL_KEY]?: OAuthState;
};

function oauthState(): OAuthState {
  const g = globalThis as GlobalWithOAuth;
  let store = g[GLOBAL_KEY];
  if (!store) {
    store = { tokens: null, loaded: false, refreshing: null };
    g[GLOBAL_KEY] = store;
  }
  return store;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokensPath(): string {
  return path.join(PATHS.root, TOKENS_FILE);
}

function notConfigured(): Error {
  return new Error(
    "Google Drive is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * POST a form-encoded body to Google's token endpoint. Retries twice on 429/5xx
 * and on transport failures; 4xx (bad code, revoked grant) fails immediately.
 */
async function postToken(form: URLSearchParams): Promise<Record<string, unknown>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);

    let res: Response;
    try {
      res = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (err) {
      lastError = new Error(`Google token request failed: ${String(err)}`);
      continue;
    }

    if (res.ok) {
      const parsed = (await res.json()) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("Google's token endpoint returned an unexpected body.");
      }
      return parsed;
    }

    const detail = truncate(await res.text().catch(() => ""));
    const failure = new Error(
      `Google token request failed (${res.status}): ${detail}`,
    );
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      lastError = failure;
      continue;
    }
    throw failure;
  }

  throw lastError ?? new Error("Google token request failed.");
}

/**
 * Shape a token response into `DriveTokens`. A refresh response omits
 * `refresh_token` (and sometimes `scope`), so previous values carry forward.
 */
function toTokens(
  raw: Record<string, unknown>,
  previousRefreshToken: string | null,
  previousScope = "",
): DriveTokens {
  const accessToken = raw.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Google did not return an access token.");
  }

  const expiresIn =
    typeof raw.expires_in === "number" && Number.isFinite(raw.expires_in)
      ? raw.expires_in
      : 3600;

  const refreshToken =
    typeof raw.refresh_token === "string" && raw.refresh_token.length > 0
      ? raw.refresh_token
      : previousRefreshToken;

  const scope =
    typeof raw.scope === "string" && raw.scope.length > 0
      ? raw.scope
      : previousScope;

  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - EXPIRY_SLACK_MS,
    scope,
  };
}

// ---------------------------------------------------------------------------
// Authorisation URL
// ---------------------------------------------------------------------------

/**
 * The consent screen URL. `prompt=consent` is deliberate: without it Google
 * only issues a refresh token on the very first authorisation, so a user who
 * reconnects would end up with an access token that dies in an hour.
 */
export function buildAuthUrl(state: string): string {
  if (!driveConfigured()) throw notConfigured();

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Code exchange / refresh
// ---------------------------------------------------------------------------

export async function exchangeCode(code: string): Promise<DriveTokens> {
  if (!driveConfigured()) throw notConfigured();

  const form = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  return toTokens(await postToken(form), null);
}

export async function refreshTokens(t: DriveTokens): Promise<DriveTokens> {
  if (!driveConfigured()) throw notConfigured();
  if (t.refreshToken === null || t.refreshToken.length === 0) {
    throw new Error("No refresh token stored — reconnect Google Drive.");
  }

  const form = new URLSearchParams({
    refresh_token: t.refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  return toTokens(await postToken(form), t.refreshToken, t.scope);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Write through a temp file so a crash can never leave a truncated token set. */
export function saveTokens(t: DriveTokens): void {
  const store = oauthState();
  store.tokens = t;
  store.loaded = true;

  const file = tokensPath();
  const tmp = `${file}.tmp`;
  try {
    ensureStorageDirs();
    fs.writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
    // umask can strip bits off the create mode; make the final file explicit.
    fs.chmodSync(file, 0o600);
  } catch (err) {
    console.error("[drive] failed to persist tokens:", err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort cleanup — the next successful write replaces it anyway.
    }
  }
}

/** The stored token set, or null when absent, unreadable or malformed. */
export function loadTokens(): DriveTokens | null {
  const store = oauthState();
  if (store.loaded) return store.tokens;

  // Set first: an unreadable file must not be re-parsed on every request.
  store.loaded = true;
  store.tokens = null;

  try {
    const parsed = JSON.parse(fs.readFileSync(tokensPath(), "utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.accessToken === "string" &&
      parsed.accessToken.length > 0 &&
      typeof parsed.expiresAt === "number" &&
      Number.isFinite(parsed.expiresAt)
    ) {
      store.tokens = {
        accessToken: parsed.accessToken,
        refreshToken:
          typeof parsed.refreshToken === "string" && parsed.refreshToken.length > 0
            ? parsed.refreshToken
            : null,
        expiresAt: parsed.expiresAt,
        scope: typeof parsed.scope === "string" ? parsed.scope : "",
      };
    }
  } catch {
    // No file yet (the normal cold start) or corrupt JSON — stay disconnected.
  }

  return store.tokens;
}

export function clearTokens(): void {
  const store = oauthState();
  store.tokens = null;
  store.loaded = true;
  store.refreshing = null;

  try {
    fs.rmSync(tokensPath(), { force: true });
  } catch (err) {
    console.error("[drive] failed to remove stored tokens:", err);
  }
}

// ---------------------------------------------------------------------------
// getValidAccessToken
// ---------------------------------------------------------------------------

async function refreshAndStore(tokens: DriveTokens): Promise<string | null> {
  try {
    const refreshed = await refreshTokens(tokens);
    saveTokens(refreshed);
    return refreshed.accessToken;
  } catch (err) {
    // The grant is gone (revoked, expired, or the client changed). Drop it so
    // the UI falls back to "Connect Google Drive" instead of looping on 401s.
    console.error("[drive] token refresh failed:", err);
    clearTokens();
    return null;
  }
}

/**
 * A usable access token, refreshing when needed. Null means "not connected" —
 * callers should answer 401 and let the user re-authorise.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (tokens === null) return null;

  if (Date.now() < tokens.expiresAt) return tokens.accessToken;

  if (tokens.refreshToken === null) {
    // Expired with nothing to refresh from: the stored set is dead weight.
    clearTokens();
    return null;
  }

  const store = oauthState();
  if (store.refreshing !== null) return store.refreshing;

  const inFlight = refreshAndStore(tokens).finally(() => {
    if (oauthState().refreshing === inFlight) oauthState().refreshing = null;
  });
  store.refreshing = inFlight;
  return inFlight;
}
