import { NextRequest, NextResponse } from "next/server";
import {
  clientIp,
  createElevenLabsTts,
  createOpenAISecret,
  createSimliSession,
  isRateLimited,
  resolveTtsProvider,
} from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side session bootstrap. Returns only short-lived credentials:
 * - OpenAI Realtime client secret (ek_..., 120 s)
 * - Simli session token + ICE servers
 * - ElevenLabs single-use TTS WebSocket URL (when TTS_PROVIDER=elevenlabs)
 * OPENAI_API_KEY, SIMLI_API_KEY and ELEVENLABS_API_KEY never reach the browser.
 */
export async function POST(req: NextRequest) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const simliKey = process.env.SIMLI_API_KEY;
  if (!openaiKey || !simliKey) {
    return NextResponse.json({ error: "Server is missing OPENAI_API_KEY or SIMLI_API_KEY" }, { status: 500 });
  }
  if (isRateLimited("session", clientIp(req.headers), Number(process.env.SESSION_RATE_LIMIT || 10))) {
    return NextResponse.json({ error: "Demasiadas sesiones, intenta más tarde." }, { status: 429 });
  }

  const provider = resolveTtsProvider();
  try {
    const [openai, simli, eleven] = await Promise.all([
      createOpenAISecret(openaiKey, provider),
      createSimliSession(simliKey),
      provider === "elevenlabs" ? createElevenLabsTts(process.env.ELEVENLABS_API_KEY as string) : Promise.resolve(null),
    ]);
    return NextResponse.json(
      { openai, simli, tts: { provider, elevenlabs: eleven } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    console.error("[api/session]", err?.message || err);
    return NextResponse.json({ error: "No se pudo iniciar la sesión" }, { status: 502 });
  }
}
