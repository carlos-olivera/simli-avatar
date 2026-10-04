import { DEFAULT_INSTRUCTIONS } from "./prompts";

export type TtsProvider = "openai" | "elevenlabs";

export const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini";
export const OPENAI_VOICE = process.env.OPENAI_VOICE || "marin";
// Default face from the official create-simli-app-openai example.
export const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID || "710aff0c-4988-46ca-a4dc-e12b559b3139";
const SIMLI_MODEL = process.env.SIMLI_MODEL || "fasttalk";
const SIMLI_MAX_SESSION_SECONDS = Number(process.env.SIMLI_MAX_SESSION_SECONDS || 600);
const SIMLI_MAX_IDLE_SECONDS = Number(process.env.SIMLI_MAX_IDLE_SECONDS || 120);

export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JddqVF50ZSIR7SRbJE6u";
export const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
const ELEVENLABS_LANGUAGE = process.env.ELEVENLABS_LANGUAGE || "es";

/** Which TTS path to use. Falls back to OpenAI voice if ElevenLabs is selected but not configured. */
export function resolveTtsProvider(): TtsProvider {
  const wanted = (process.env.TTS_PROVIDER || "elevenlabs").toLowerCase();
  if (wanted === "openai") return "openai";
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn("[tts] TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is missing; falling back to OpenAI voice");
    return "openai";
  }
  return "elevenlabs";
}

// ---- tiny in-memory per-IP rate limiter ----
const buckets = new Map<string, Map<string, number[]>>();
export function isRateLimited(bucket: string, ip: string, limit: number, windowMs = 10 * 60 * 1000): boolean {
  let hits = buckets.get(bucket);
  if (!hits) buckets.set(bucket, (hits = new Map()));
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  const limited = recent.length >= limit;
  if (!limited) recent.push(now);
  hits.set(ip, recent);
  return limited;
}

export function clientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// ---- OpenAI Realtime (GA) client secret ----
export async function createOpenAISecret(apiKey: string, provider: TtsProvider) {
  const input = {
    format: { type: "audio/pcm", rate: 24000 },
    turn_detection: { type: "server_vad" },
    transcription: { model: "gpt-4o-mini-transcribe", language: "es" },
  };
  const session =
    provider === "elevenlabs"
      ? {
          // OpenAI does STT + turn detection + LLM; speech comes from ElevenLabs.
          type: "realtime",
          model: OPENAI_MODEL,
          instructions: process.env.AVATAR_INSTRUCTIONS || DEFAULT_INSTRUCTIONS,
          output_modalities: ["text"],
          audio: { input },
        }
      : {
          type: "realtime",
          model: OPENAI_MODEL,
          instructions: process.env.AVATAR_INSTRUCTIONS || DEFAULT_INSTRUCTIONS,
          output_modalities: ["audio"],
          audio: {
            input,
            output: { format: { type: "audio/pcm", rate: 24000 }, voice: OPENAI_VOICE },
          },
        };

  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 120 }, session }),
  });
  if (!res.ok) throw new Error(`OpenAI client_secrets failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { value: data.value as string, expires_at: data.expires_at as number, model: OPENAI_MODEL };
}

// ---- Simli session token + ICE ----
export async function createSimliSession(apiKey: string) {
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
  if (!tokenRes.ok) throw new Error(`Simli token failed: ${tokenRes.status} ${await tokenRes.text()}`);
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

// ---- ElevenLabs single-use token for the multi-context TTS WebSocket ----
export async function createElevenLabsTts(apiKey: string) {
  const res = await fetch("https://api.elevenlabs.io/v1/single-use-token/tts_websocket", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`ElevenLabs single-use token failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  const params = new URLSearchParams({
    model_id: ELEVENLABS_MODEL_ID,
    output_format: "pcm_16000", // PCM16 @ 16 kHz = exactly what Simli consumes
    language_code: ELEVENLABS_LANGUAGE,
    inactivity_timeout: "180",
    single_use_token: token,
  });
  return {
    url: `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}/multi-stream-input?${params}`,
    voiceId: ELEVENLABS_VOICE_ID,
    modelId: ELEVENLABS_MODEL_ID,
  };
}
