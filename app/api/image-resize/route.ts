import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

function optionalCwd(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { getRpcImageAutoResize } = await import("@/lib/rpc-manager");
  const cwd = optionalCwd(new URL(req.url).searchParams.get("cwd"));
  return Response.json({ enabled: getRpcImageAutoResize(cwd) });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { enabled?: unknown; cwd?: unknown };
    if (typeof body.enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    const { applyRpcImageAutoResize } = await import("@/lib/rpc-manager");
    return Response.json({
      enabled: body.enabled,
      sessions: await applyRpcImageAutoResize(body.enabled, optionalCwd(body.cwd)),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
