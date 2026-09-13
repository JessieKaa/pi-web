import { buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs, createListedModelRuntime } from "@/lib/provider-listing-runtime";


// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET() {
  const modelRuntime = await createListedModelRuntime();
  const providers = buildOAuthProviderList(await collectProviderListingInputs(modelRuntime));
  return Response.json({ providers });
}
