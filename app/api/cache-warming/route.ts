import type { CacheWarmingMode } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

// The SDK keeps CACHE_WARMING_MODES internal (settings-manager) and only exports the type.
const CACHE_WARMING_MODES: CacheWarmingMode[] = ["off", "streaming", "idle"];

function parseMode(value: unknown): CacheWarmingMode | null {
  return CACHE_WARMING_MODES.find((mode) => mode === value) ?? null;
}

function optionalCwd(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { getRpcCacheWarmingMode } = await import("@/lib/rpc-manager");
  const cwd = optionalCwd(new URL(req.url).searchParams.get("cwd"));
  return Response.json({ mode: getRpcCacheWarmingMode(cwd) });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { mode?: unknown; cwd?: unknown };
    const mode = parseMode(body.mode);
    if (!mode) {
      return Response.json(
        { error: `mode must be one of ${CACHE_WARMING_MODES.join(", ")}` },
        { status: 400 },
      );
    }
    const { applyRpcCacheWarmingMode } = await import("@/lib/rpc-manager");
    return Response.json({ mode, sessions: applyRpcCacheWarmingMode(mode, optionalCwd(body.cwd)) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
