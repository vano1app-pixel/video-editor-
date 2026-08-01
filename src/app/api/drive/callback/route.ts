import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { exchangeCode, saveTokens } from "@/lib/drive/oauth";

export const runtime = "nodejs";

/** Set by /api/drive/auth. */
const STATE_COOKIE = "editai_drive_state";

/**
 * Google's redirect target. A human is looking at this URL, so every path ends
 * in a redirect back to the app — never JSON. Failures carry a short machine
 * reason the picker turns into a readable line.
 */
export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;

  /** Redirect home, always burning the one-shot state cookie. */
  const home = (target: string): NextResponse => {
    const res = NextResponse.redirect(new URL(target, origin), 303);
    res.cookies.set({
      name: STATE_COOKIE,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return res;
  };

  const fail = (reason: string): NextResponse =>
    home(`/?drive=error&reason=${encodeURIComponent(reason)}`);

  try {
    const params = new URL(req.url).searchParams;
    const errorParam = params.get("error");
    if (errorParam !== null && errorParam !== "") {
      // "access_denied" is the common one: the user pressed Cancel.
      return fail(shortReason(errorParam));
    }

    const code = params.get("code");
    if (code === null || code === "") return fail("no_code");

    const state = params.get("state");
    const expected = (await cookies()).get(STATE_COOKIE)?.value ?? null;
    if (state === null || expected === null || state !== expected) {
      return fail("state");
    }

    saveTokens(await exchangeCode(code));
    return home("/?drive=connected");
  } catch (err) {
    console.error("[drive] callback failed:", err);
    return fail("exchange");
  }
}

/** Keep Google's error code, but only as a short, URL-safe token. */
function shortReason(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z_]/g, "");
  if (cleaned === "access_denied") return "denied";
  return cleaned.length > 0 ? cleaned.slice(0, 32) : "unknown";
}
