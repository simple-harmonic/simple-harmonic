import { platformStatus } from "../../store";

/**
 * GET /api/settings/platform-status
 * Returns current platform status.
 */
export async function GET() {
  try {
    const ps = await platformStatus.get();
    if (ps) return Response.json(ps);
    return Response.json({ id: 1, status: "healthy", message: null, updatedAt: new Date() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/settings/platform-status
 * Founder sets platform status. Body: { status: "healthy"|"degraded"|"maintenance", message?: string }
 */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    status: "healthy" | "degraded" | "maintenance";
    message?: string | null;
  } | null;

  const validStatuses = ["healthy", "degraded", "maintenance"];
  if (!body || !validStatuses.includes(body.status)) {
    return Response.json(
      { error: `status must be one of: ${validStatuses.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    await platformStatus.set({ status: body.status, message: body.message ?? null });
    return Response.json({ ok: true, status: body.status, message: body.message ?? null });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
