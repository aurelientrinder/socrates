import { cancelGoogleSignIn, disconnectGoogle, googleCalendarStatus, startGoogleSignIn } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(googleCalendarStatus());
}

/** { action: "connect" } → { authUrl } for the real browser; "cancel" | "disconnect". */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { action?: unknown };
	switch (body.action) {
		case "connect": {
			const started = await startGoogleSignIn();
			return started.ok
				? Response.json({ authUrl: started.authUrl, status: googleCalendarStatus() })
				: Response.json({ error: started.error }, { status: 400 });
		}
		case "cancel":
			cancelGoogleSignIn();
			return Response.json(googleCalendarStatus());
		case "disconnect":
			await disconnectGoogle();
			return Response.json(googleCalendarStatus());
		default:
			return Response.json({ error: 'action must be "connect", "cancel" or "disconnect"' }, { status: 400 });
	}
}
