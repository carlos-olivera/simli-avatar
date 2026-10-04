"use client";
import IconSparkleLoader from "@/media/IconSparkleLoader";
import React, { useCallback, useRef, useState } from "react";
import { SimliClient, LogLevel } from "simli-client";
import VideoBox from "./Components/VideoBox";
import { ElevenTTS } from "@/lib/elevenTts";
import cn from "./utils/TailwindMergeAndClsx";

interface SessionResponse {
    openai: { value: string; expires_at: number; model: string };
    simli: { session_token: string; iceServers: RTCIceServer[] };
    tts: { provider: "openai" | "elevenlabs"; elevenlabs: { url: string } | null };
}

let simliClient: SimliClient | null = null;

/** Int16 PCM -> base64 */
function int16ToBase64(data: Int16Array): string {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
}

/** base64 -> Int16 PCM */
function base64ToInt16(b64: string): Int16Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

/** Downsample 24 kHz PCM16 to 16 kHz with a small FIR low-pass + linear interpolation. */
function downsample(data: Int16Array, inRate: number, outRate: number): Int16Array {
    if (inRate === outRate) return data;
    const taps = 31;
    const fc = (outRate / 2) / inRate;
    const mid = (taps - 1) / 2;
    const coeffs = new Float32Array(taps);
    for (let i = 0; i < taps; i++) {
        coeffs[i] = i === mid ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * (i - mid)) / (i - mid);
        coeffs[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    }
    const sum = coeffs.reduce((a, b) => a + b, 0);
    for (let i = 0; i < taps; i++) coeffs[i] /= sum;

    const filtered = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        let acc = 0;
        for (let j = 0; j < taps; j++) {
            const idx = i - j + mid;
            if (idx >= 0 && idx < data.length) acc += coeffs[j] * data[idx];
        }
        filtered[i] = acc;
    }

    const ratio = inRate / outRate;
    const outLen = Math.floor(data.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = filtered[idx];
        const b = idx + 1 < filtered.length ? filtered[idx + 1] : a;
        out[i] = Math.max(-32768, Math.min(32767, Math.round(a + frac * (b - a))));
    }
    return out;
}

const SimliOpenAI: React.FC = () => {
    const [isLoading, setIsLoading] = useState(false);
    const [isActive, setIsActive] = useState(false);
    const [error, setError] = useState("");

    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const ttsRef = useRef<ElevenTTS | null>(null);
    const responseIdRef = useRef<string | null>(null);
    const tSpeechStopRef = useRef<number>(0);

    const sendEvent = (event: Record<string, unknown>) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    };

    const startRecording = useCallback(async () => {
        try {
            audioContextRef.current = new AudioContext({ sampleRate: 24000 });
            streamRef.current = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
            processorRef.current = audioContextRef.current.createScriptProcessor(2048, 1, 1);
            processorRef.current.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                const pcm = new Int16Array(input.length);
                for (let i = 0; i < input.length; i++) {
                    const s = Math.max(-1, Math.min(1, input[i]));
                    pcm[i] = Math.floor(s * 32767);
                }
                sendEvent({ type: "input_audio_buffer.append", audio: int16ToBase64(pcm) });
            };
            source.connect(processorRef.current);
            processorRef.current.connect(audioContextRef.current.destination);
        } catch (err) {
            console.error("Error accessing microphone:", err);
            setError("No se pudo acceder al micrófono. Revisa los permisos del navegador.");
        }
    }, []);

    const stopRecording = useCallback(() => {
        processorRef.current?.disconnect();
        processorRef.current = null;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        audioContextRef.current?.close().catch(() => undefined);
        audioContextRef.current = null;
    }, []);

    /** Connects to the OpenAI Realtime API (GA) over WebSocket using the ephemeral key. */
    const connectOpenAI = useCallback(
        (openai: SessionResponse["openai"], tts: ElevenTTS | null) => {
            const ws = new WebSocket(
                `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(openai.model)}`,
                ["realtime", `openai-insecure-api-key.${openai.value}`]
            );
            wsRef.current = ws;

            ws.onopen = () => {
                console.log("OpenAI Realtime connected");
                // Let the avatar greet first (session config comes from the server-minted secret).
                sendEvent({ type: "response.create" });
                startRecording();
            };

            ws.onmessage = (msg) => {
                let event: any;
                try {
                    event = JSON.parse(msg.data);
                } catch {
                    return;
                }
                switch (event.type) {
                    // ---- ElevenLabs path: OpenAI streams text, ElevenLabs speaks it ----
                    case "response.created":
                        responseIdRef.current = event.response?.id ?? null;
                        if (tts) tts.begin();
                        break;
                    case "response.output_text.delta":
                        if (tts && event.response_id === responseIdRef.current) {
                            if (tSpeechStopRef.current) {
                                console.log(`[latency] fin de voz -> primer texto: ${Math.round(performance.now() - tSpeechStopRef.current)} ms`);
                            }
                            tts.push(event.delta);
                        }
                        break;
                    case "response.output_text.done":
                        if (tts && event.response_id === responseIdRef.current) {
                            tts.end();
                            console.log("Avatar:", event.text);
                        }
                        break;
                    case "input_audio_buffer.speech_stopped":
                        tSpeechStopRef.current = performance.now();
                        break;
                    // ---- OpenAI voice fallback path ----
                    case "response.output_audio.delta":
                    case "response.audio.delta": {
                        const pcm24 = base64ToInt16(event.delta);
                        const pcm16 = downsample(pcm24, 24000, 16000);
                        simliClient?.sendAudioData(
                            new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
                        );
                        break;
                    }
                    case "input_audio_buffer.speech_started":
                        // User barged in: stop TTS and drop whatever the avatar is still saying.
                        tts?.interrupt();
                        simliClient?.ClearBuffer();
                        break;
                    case "conversation.item.input_audio_transcription.completed":
                        console.log("Usuario:", event.transcript);
                        break;
                    case "response.output_audio_transcript.done":
                        console.log("Avatar:", event.transcript);
                        break;
                    case "error":
                        console.error("OpenAI error:", event.error);
                        break;
                    default:
                        break;
                }
            };

            ws.onerror = (e) => {
                console.error("OpenAI WebSocket error", e);
                setError("Error de conexión con OpenAI.");
            };
            ws.onclose = (e) => console.log("OpenAI WebSocket closed", e.code, e.reason);
        },
        [startRecording]
    );

    const stopTts = () => {
        ttsRef.current?.close();
        ttsRef.current = null;
    };

    const handleStart = useCallback(async () => {
        setIsLoading(true);
        setError("");
        try {
            const res = await fetch("/api/session", { method: "POST" });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            const session = data as SessionResponse;

            if (!videoRef.current || !audioRef.current) throw new Error("Video element not ready");
            simliClient = new SimliClient(
                session.simli.session_token,
                videoRef.current,
                audioRef.current,
                session.simli.iceServers,
                LogLevel.ERROR,
                "p2p"
            );
            simliClient.on("start", () => {
                console.log("Simli connected");
                setIsActive(true);
                setIsLoading(false);
                let tts: ElevenTTS | null = null;
                if (session.tts?.provider === "elevenlabs" && session.tts.elevenlabs) {
                    tts = new ElevenTTS(
                        session.tts.elevenlabs.url,
                        async () => {
                            const r = await fetch("/api/tts-token", { method: "POST" });
                            if (!r.ok) throw new Error(`tts-token HTTP ${r.status}`);
                            return (await r.json()).url as string;
                        },
                        (pcm) => simliClient?.sendAudioData(pcm)
                    );
                    tts.onFirstAudio = () => {
                        if (tSpeechStopRef.current) {
                            console.log(`[latency] fin de voz -> primer audio ElevenLabs: ${Math.round(performance.now() - tSpeechStopRef.current)} ms`);
                        }
                    };
                    tts.warmUp();
                    ttsRef.current = tts;
                }
                connectOpenAI(session.openai, tts);
            });
            simliClient.on("stop", () => {
                console.log("Simli disconnected");
                wsRef.current?.close();
                stopTts();
                stopRecording();
                setIsActive(false);
            });
            await simliClient.start();
        } catch (err: any) {
            console.error("Error starting interaction:", err);
            setError(`No se pudo iniciar: ${err?.message || err}`);
            setIsLoading(false);
        }
    }, [connectOpenAI, stopRecording]);

    const handleStop = useCallback(async () => {
        stopRecording();
        wsRef.current?.close();
        wsRef.current = null;
        stopTts();
        await simliClient?.stop();
        simliClient = null;
        setIsActive(false);
        setIsLoading(false);
    }, [stopRecording]);

    return (
        <div className="flex flex-col items-center">
            <VideoBox video={videoRef} audio={audioRef} />
            <div className="mt-6 flex flex-col items-center">
                {!isActive ? (
                    <button
                        onClick={handleStart}
                        disabled={isLoading}
                        className={cn(
                            "h-[48px] min-w-[220px] px-6 rounded-full text-white bg-white/10 hover:bg-white hover:text-black transition-all duration-300 disabled:opacity-50",
                            "flex justify-center items-center"
                        )}
                    >
                        {isLoading ? (
                            <IconSparkleLoader className="h-[20px] animate-loader" />
                        ) : (
                            <span className="font-abc-repro-mono font-bold">Iniciar conversación</span>
                        )}
                    </button>
                ) : (
                    <button
                        onClick={handleStop}
                        className="h-[48px] min-w-[220px] px-6 rounded-full text-white/80 bg-white/5 hover:bg-red hover:text-white transition-all duration-300"
                    >
                        <span className="font-abc-repro-mono font-bold">Terminar</span>
                    </button>
                )}
                {error && <p className="mt-3 text-sm text-red">{error}</p>}
            </div>
        </div>
    );
};

export default SimliOpenAI;
