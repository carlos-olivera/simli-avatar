# simli-avatar

Conversational avatar demo (Spanish, Bolivian neutral) built on
[simliai/create-simli-app-openai](https://github.com/simliai/create-simli-app-openai):
Simli renders the face. OpenAI Realtime (GA API) does Spanish STT, turn detection and the LLM (text output);
ElevenLabs (multi-context WebSocket, `eleven_flash_v2_5`, `pcm_16000`) speaks the reply and its PCM is fed straight into Simli.
Set `TTS_PROVIDER=openai` to fall back to OpenAI's own voice (`OPENAI_VOICE`).

Pipeline: mic → OpenAI Realtime (server VAD + transcription + LLM, text deltas) → sentence chunks →
ElevenLabs TTS WebSocket (single-use token) → PCM16 16 kHz → Simli WebRTC avatar.
Barge-in: on `input_audio_buffer.speech_started` the active ElevenLabs context is closed, its late audio is dropped
and Simli's buffer is cleared.

## Security model
- `OPENAI_API_KEY` and `SIMLI_API_KEY` live **only on the server**.
- `POST /api/session` mints a short-lived OpenAI Realtime client secret (`/v1/realtime/client_secrets`, `ek_…`, 120 s)
  plus a Simli session token and ICE servers, plus an ElevenLabs single-use TTS WebSocket token (`/v1/single-use-token/tts_websocket`).
  `POST /api/tts-token` mints a fresh ElevenLabs token if the TTS socket idles out. The browser only ever sees these ephemeral tokens.
- Avatar instructions are baked into the client secret server-side.
- Basic in-memory per-IP rate limit (`SESSION_RATE_LIMIT`, default 10 sessions / 10 min).

## Environment variables
| Name | Required | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | – |
| `SIMLI_API_KEY` | yes | – |
| `SIMLI_FACE_ID` | no | `710aff0c-4988-46ca-a4dc-e12b559b3139` (example default) |
| `AVATAR_INSTRUCTIONS` | no | PIL Andina persona in `lib/prompts.ts` |
| `TTS_PROVIDER` | no | `elevenlabs` (`openai` = OpenAI voice) |
| `ELEVENLABS_API_KEY` | for ElevenLabs | – |
| `ELEVENLABS_VOICE_ID` | no | `JddqVF50ZSIR7SRbJE6u` |
| `ELEVENLABS_MODEL_ID` / `ELEVENLABS_LANGUAGE` | no | `eleven_flash_v2_5` / `es` |
| `OPENAI_REALTIME_MODEL` | no | `gpt-realtime-2.1-mini` |
| `OPENAI_VOICE` | no | `marin` (only with `TTS_PROVIDER=openai`) |
| `SIMLI_MODEL` | no | `fasttalk` |
| `SIMLI_MAX_SESSION_SECONDS` / `SIMLI_MAX_IDLE_SECONDS` | no | `600` / `120` |
| `LOGO_URL` (runtime) or `NEXT_PUBLIC_LOGO_URL` (build time) | no | none |

## Run
```bash
npm install
cp .env_sample .env.local   # fill in keys
npm run dev                 # or: npm run build && npm start  (honours $PORT)
```
