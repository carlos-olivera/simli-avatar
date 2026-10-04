import { NextRequest, NextResponse } from "next/server";
import { clientIp, createElevenLabsTts, isRateLimited, resolveTtsProvider } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Fresh single-use ElevenLabs TTS WebSocket URL (used to reconnect after the socket idles out). */
export async function POST(req: NextRequest) {
  if (resolveTtsProvider() !== "elevenlabs") {
    return NextResponse.json({ error: "ElevenLabs TTS not enabled" }, { status: 400 });
  }
  if (isRateLimited("tts-token", clientIp(req.headers), Number(process.env.TTS_TOKEN_RATE_LIMIT || 40))) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  try {
    const eleven = await createElevenLabsTts(process.env.ELEVENLABS_API_KEY as string);
    return NextResponse.json(eleven, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.error("[api/tts-token]", err?.message || err);
    return NextResponse.json({ error: "No se pudo obtener token de voz" }, { status: 502 });
  }
}
