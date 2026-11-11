import { freshModelCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): the Gemini catalog as
 * client-safe DTOs — id/name/cost/context/modality plus each model's
 * SUPPORTED thinking levels. The baked list is extended with whatever
 * Google's `models.list` returns for the saved key (cached 10 minutes;
 * offline or a bad key falls back to the baked list), so a newly released
 * Gemini model appears without an app update. A model Google has not opened
 * to the key stays absent by design.
 */
export async function GET() {
	return Response.json(await freshModelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
