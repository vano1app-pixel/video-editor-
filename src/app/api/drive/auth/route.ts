import { NextResponse } from "next/server";

import { driveConfigured } from "@/lib/config";
import { buildAuthUrl } from "@/lib/drive/oauth";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

/** Shared with /api/drive/callback, which checks it against the `state` param. */
const STATE_COOKIE = "editai_drive_state";
const STATE_TTL_SECONDS = 600;

/**
 * Kick off the consent flow. The browser navigates here directly (it is a link,
 * not a fetch), so the response is a redirect to Google with a one-shot CSRF
 * state parked in an httpOnly cookie.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    if (!driveConfigured()) {
      const body: ApiError = {
        error:
          "Google Drive isn't configured on this server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart.",
      };
      return NextResponse.json(body, { status: 503 });
    }

    const state = crypto.randomUUID();
    const res = NextResponse.redirect(buildAuthUrl(state), 307);

    res.cookies.set({
      name: STATE_COOKIE,
      value: state,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: STATE_TTL_SECONDS,
      // Google's redirect back is a top-level GET, so `lax` still sends it.
      secure: new URL(req.url).protocol === "https:",
    });

    return res;
  } catch (err) {
    const body: ApiError = {
      error: "Could not start the Google Drive connection.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}
