import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  assertTitleGenerationPreference,
  readTitleGenerationPreference,
  updateTitleGenerationPreference,
} from "@/lib/title-generation-settings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return Response.json({ preference: await readTitleGenerationPreference() });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
    }
    if (!isRecord(body) || !Object.hasOwn(body, "preference")) {
      return Response.json({ error: "preference is required" }, { status: 400 });
    }

    let preference;
    try {
      preference = assertTitleGenerationPreference(body.preference);
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 });
    }

    return Response.json({ preference: await updateTitleGenerationPreference(preference) });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}
