import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side session bootstrap.
 * - Mints a short-lived OpenAI Realtime client secret (ek_...) using OPENAI_API_KEY.
 * - Mints a Simli session token + ICE servers using SIMLI_API_KEY.
 * Neither long-lived API key ever reaches the browser.
 */

const DEFAULT_INSTRUCTIONS =
  "Eres un asistente virtual amable y profesional. Responde SIEMPRE en español, " +
  "con un acento y vocabulario neutro de Bolivia, claro y cordial. " +
  "Tus respuestas son breves, naturales y conversacionales (una a tres oraciones). " +
  "Si no entiendes algo, pide amablemente que lo repitan.";

const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "marin";
// Default face from the official create-simli-app-openai example.
const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID || "710aff0c-4988-46ca-a4dc-e12b559b3139";
const SIMLI_MODEL = process.env.SIMLI_MODEL || "fasttalk";
const SIMLI_MAX_SESSION_SECONDS = Number(process.env.SIMLI_MAX_SESSION_SECONDS || 600);
const SIMLI_MAX_IDLE_SECONDS = Number(process.env.SIMLI_MAX_IDLE_SECONDS || 120);

// Very small in-memory rate limit per IP to avoid casual credit abuse.
const RATE_LIMIT = Number(process.env.SESSION_RATE_LIMIT || 10); // sessions
const RATE_WINDOW_MS = 10 * 60 * 1000; // per 10 minutes
const hits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

async function createOpenAISecret(apiKey: string) {
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 120 },
      session: {
        type: "realtime",
        model: OPENAI_MODEL,
        instructions: process.env.AVATAR_INSTRUCTIONS || DEFAULT_INSTRUCTIONS,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: { type: "server_vad" },
            transcription: { model: "gpt-4o-mini-transcribe", language: "es" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: OPENAI_VOICE,
          },
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI client_secrets failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { value: data.value as string, expires_at: data.expires_at as number, model: OPENAI_MODEL };
}

async function createSimliSession(apiKey: string) {
  const tokenRes = await fetch("https://api.simli.ai/compose/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-simli-api-key": apiKey },
    body: JSON.stringify({
      faceId: SIMLI_FACE_ID,
      handleSilence: true,
      maxSessionLength: SIMLI_MAX_SESSION_SECONDS,
      maxIdleTime: SIMLI_MAX_IDLE_SECONDS,
      model: SIMLI_MODEL,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Simli token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { session_token } = await tokenRes.json();

  let iceServers: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];
  try {
    const iceRes = await fetch("https://api.simli.ai/compose/ice", {
      headers: { "Content-Type": "application/json", "x-simli-api-key": apiKey },
    });
    if (iceRes.ok) {
      const ice = await iceRes.json();
      if (Array.isArray(ice) && ice.length > 0) iceServers = ice;
    }
  } catch {
    // fall back to public STUN
  }
  return { session_token: session_token as string, iceServers };
}

export async function POST(req: NextRequest) {
  const openaiKey = process.env.OPENAI_API_KEY;
  const simliKey = process.env.SIMLI_API_KEY;
  if (!openaiKey || !simliKey) {
    return NextResponse.json({ error: "Server is missing OPENAI_API_KEY or SIMLI_API_KEY" }, { status: 500 });
  }

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Demasiadas sesiones, intenta más tarde." }, { status: 429 });
  }

  try {
    const [openai, simli] = await Promise.all([createOpenAISecret(openaiKey), createSimliSession(simliKey)]);
    return NextResponse.json({ openai, simli }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.error("[api/session]", err?.message || err);
    return NextResponse.json({ error: "No se pudo iniciar la sesión" }, { status: 502 });
  }
}
