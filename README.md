# simli-avatar

Conversational avatar demo (Spanish, Bolivian neutral) built on
[simliai/create-simli-app-openai](https://github.com/simliai/create-simli-app-openai):
Simli renders the face, OpenAI Realtime (GA API) handles voice-to-voice.

## Security model
- `OPENAI_API_KEY` and `SIMLI_API_KEY` live **only on the server**.
- `POST /api/session` mints a short-lived OpenAI Realtime client secret (`/v1/realtime/client_secrets`, `ek_…`, 120 s)
  plus a Simli session token and ICE servers. The browser only ever sees these ephemeral tokens.
- Avatar instructions are baked into the client secret server-side.
- Basic in-memory per-IP rate limit (`SESSION_RATE_LIMIT`, default 10 sessions / 10 min).

## Environment variables
| Name | Required | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | – |
| `SIMLI_API_KEY` | yes | – |
| `SIMLI_FACE_ID` | no | `710aff0c-4988-46ca-a4dc-e12b559b3139` (example default) |
| `AVATAR_INSTRUCTIONS` | no | Spanish (Bolivia) assistant prompt |
| `OPENAI_REALTIME_MODEL` | no | `gpt-realtime-2.1-mini` |
| `OPENAI_VOICE` | no | `marin` |
| `SIMLI_MODEL` | no | `fasttalk` |
| `SIMLI_MAX_SESSION_SECONDS` / `SIMLI_MAX_IDLE_SECONDS` | no | `600` / `120` |
| `LOGO_URL` (runtime) or `NEXT_PUBLIC_LOGO_URL` (build time) | no | none |

## Run
```bash
npm install
cp .env_sample .env.local   # fill in keys
npm run dev                 # or: npm run build && npm start  (honours $PORT)
```
