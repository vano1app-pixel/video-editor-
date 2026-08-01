import { NextResponse } from "next/server";

import { driveConfigured } from "@/lib/config";
import { loadTokens } from "@/lib/drive/oauth";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";

export interface DriveStatusResponse {
  /** The server has GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. */
  configured: boolean;
  /** A token set is stored, so the picker can list files. */
  connected: boolean;
}

/**
 * Cheap poll the picker runs on mount. An unconfigured server is a normal,
 * successful answer — never an error — so the UI can show setup instructions.
 */
export async function GET(_req: Request): Promise<Response> {
  try {
    const payload: DriveStatusResponse = {
      configured: driveConfigured(),
      connected: loadTokens() !== null,
    };
    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    const body: ApiError = {
      error: "Could not check the Google Drive connection.",
      detail: String(err),
    };
    return NextResponse.json(body, { status: 500 });
  }
}
