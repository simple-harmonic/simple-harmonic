import * as apollo from "@simple-harmonic/backend/server/apollo";
import { NextResponse } from "next/server";

// Credential endpoint for the Harmon credential-request flow.
// Secrets are encrypted at rest via Apollo (.apollo/vault.enc) and loaded
// into process.env on server start. Agents access them indirectly through
// resolveConnector() — they never see the raw value or the vault file.

export async function POST(req: Request) {
  const { key, value } = await req.json();

  if (!key || typeof key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return NextResponse.json(
      { error: "key must be uppercase with underscores (e.g. GITHUB_TOKEN)" },
      { status: 400 },
    );
  }

  if (!value || typeof value !== "string" || value.length < 1) {
    return NextResponse.json({ error: "value is required" }, { status: 400 });
  }

  // Encrypt and persist via Apollo. Also sets process.env immediately.
  apollo.set(key, value);

  return NextResponse.json({ ok: true, key });
}
