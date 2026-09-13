import { buildApiKeyProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs, createListedModelRuntime } from "@/lib/provider-listing-runtime";


// Providers that accept an API key, including dual-auth ones such as anthropic —
// see lib/provider-listing.ts for why membership is capability-based (#309).
export async function GET() {
  const modelRuntime = await createListedModelRuntime();
  const providers = buildApiKeyProviderList(await collectProviderListingInputs(modelRuntime));
  return Response.json({ providers });
}
