// Mints a short-lived, single-use token so the browser can talk to Gemini Live directly.
// The real GEMINI_API_KEY never leaves the server.

import { GoogleGenAI } from "@google/genai";
import { LIVE_MODEL, buildLiveConfig } from "@/lib/agent";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "Server is missing GEMINI_API_KEY." }, { status: 500 });
  }
  if (!rateLimit(`session:${clientIp(req)}`, 15, 60 * 60 * 1000)) {
    return Response.json({ error: "Too many calls from this network. Please try again in a while." }, { status: 429 });
  }

  const config = buildLiveConfig();

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 20 * 60 * 1000).toISOString(), // whole call must finish within 20 min
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(), // must connect within 1 min
        // Lock the model, persona, guardrails and tools into the token,
        // so a modified client can't swap in a different prompt.
        liveConnectConstraints: { model: LIVE_MODEL, config },
      },
    });

    return Response.json({ token: token.name, model: LIVE_MODEL, config });
  } catch (e) {
    console.error("Token creation failed", e);
    return Response.json({ error: "Could not start a voice session. Check the API key and quota." }, { status: 502 });
  }
}
