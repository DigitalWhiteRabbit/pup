"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Mic, X, Send, Play, Pause, Type, Loader2 } from "lucide-react";

/* ── VoiceRecorder ── */

export function VoiceRecorder({
  onRecorded,
  disabled,
}: {
  onRecorded: (file: File) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4",
      });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: mr.mimeType });
          const ext = mr.mimeType.includes("webm") ? "webm" : "m4a";
          const file = new File([blob], `voice-${Date.now()}.${ext}`, {
            type: mr.mimeType,
          });
          onRecorded(file);
        }
        setDuration(0);
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      setDuration(0);
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch {
      // microphone permission denied
    }
  }, [onRecorded]);

  const stopAndSend = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    chunksRef.current = [];
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setRecording(false);
    setDuration(0);
  }, []);

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  if (recording) {
    return (
      <div className="flex items-center gap-3 flex-1">
        <button
          onClick={cancel}
          className="w-8 h-8 rounded-full hover:bg-muted flex items-center justify-center shrink-0 text-muted-foreground"
          title="Отменить"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 flex-1">
          <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
          <div className="flex-1 h-1 bg-red-500/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-red-500 rounded-full transition-all"
              style={{ width: `${Math.min(duration * 2, 100)}%` }}
            />
          </div>
          <span className="text-xs text-red-400 font-mono w-10 text-right">
            {fmt(duration)}
          </span>
        </div>
        <button
          onClick={stopAndSend}
          className="w-9 h-9 rounded-xl bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center shrink-0"
          title="Отправить"
        >
          <Send className="w-4 h-4 text-white" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => void start()}
      disabled={disabled}
      className="w-9 h-9 rounded-lg hover:bg-muted flex items-center justify-center shrink-0 disabled:opacity-40"
      title="Голосовое сообщение"
    >
      <Mic className="w-5 h-5 text-muted-foreground" />
    </button>
  );
}

/* ── VoicePlayer (Telegram-style with transcription) ── */

const BAR_COUNT = 32;

function generateWaveform(seed: string): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
  const bars: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    h = (((h * 16807) % 2147483647) + 2147483647) % 2147483647;
    const v = (h % 100) / 100;
    const env = Math.sin((i / BAR_COUNT) * Math.PI) * 0.4 + 0.6;
    bars.push(Math.max(0.15, v * env));
  }
  return bars;
}

function fmtTime(s: number): string {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Cache transcription availability check
let _transcribeAvailable: boolean | null = null;

export function VoicePlayer({ src, isMe }: { src: string; isMe: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrent] = useState(0);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [canTranscribe, setCanTranscribe] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animRef = useRef<number>(0);

  const waveform = useMemo(() => generateWaveform(src), [src]);

  // Check if transcription is available
  useEffect(() => {
    if (_transcribeAvailable !== null) {
      setCanTranscribe(_transcribeAvailable);
      return;
    }
    void fetch("/api/transcribe")
      .then((r) => r.json())
      .then((d: { available: boolean }) => {
        _transcribeAvailable = d.available;
        setCanTranscribe(d.available);
      })
      .catch(() => {
        _transcribeAvailable = false;
      });
  }, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animRef.current);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, []);

  function ensureAudio(): HTMLAudioElement {
    if (!audioRef.current) {
      const a = new Audio(src);
      a.preload = "metadata";
      audioRef.current = a;

      a.addEventListener("loadedmetadata", () => {
        if (isFinite(a.duration)) setDuration(a.duration);
      });
      a.addEventListener("durationchange", () => {
        if (isFinite(a.duration)) setDuration(a.duration);
      });
      a.addEventListener("ended", () => {
        setPlaying(false);
        setProgress(0);
        setCurrent(0);
        cancelAnimationFrame(animRef.current);
      });

      a.addEventListener(
        "loadeddata",
        () => {
          if (!isFinite(a.duration)) {
            a.currentTime = 1e10;
            a.addEventListener("timeupdate", function fix() {
              if (isFinite(a.duration)) {
                setDuration(a.duration);
                a.currentTime = 0;
                a.removeEventListener("timeupdate", fix);
              }
            });
          }
        },
        { once: true },
      );
    }
    return audioRef.current;
  }

  function tick() {
    const a = audioRef.current;
    if (a && !a.paused) {
      const p = a.duration ? a.currentTime / a.duration : 0;
      setProgress(p);
      setCurrent(a.currentTime);
      animRef.current = requestAnimationFrame(tick);
    }
  }

  function toggle() {
    const a = ensureAudio();
    if (playing) {
      a.pause();
      setPlaying(false);
      cancelAnimationFrame(animRef.current);
    } else {
      void a.play();
      setPlaying(true);
      animRef.current = requestAnimationFrame(tick);
    }
  }

  function seekFromBar(barIndex: number) {
    const a = ensureAudio();
    const t = (barIndex / BAR_COUNT) * (a.duration || 0);
    if (isFinite(t)) {
      a.currentTime = t;
      setProgress(barIndex / BAR_COUNT);
      setCurrent(t);
    }
  }

  async function transcribe() {
    if (transcript !== null) {
      setShowTranscript(!showTranscript);
      return;
    }
    setTranscribing(true);
    try {
      // Fetch the audio file
      const audioRes = await fetch(src);
      const blob = await audioRes.blob();
      const fd = new FormData();
      fd.append(
        "file",
        new File([blob], "voice.webm", { type: blob.type || "audio/webm" }),
      );

      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      if (!res.ok) throw new Error("Transcription failed");

      const data = (await res.json()) as { text: string };
      setTranscript(data.text);
      setShowTranscript(true);
    } catch {
      setTranscript("Не удалось распознать");
      setShowTranscript(true);
    } finally {
      setTranscribing(false);
    }
  }

  const playedBars = Math.floor(progress * BAR_COUNT);
  const timeLabel =
    playing || currentTime > 0 ? fmtTime(currentTime) : fmtTime(duration);

  return (
    <div className="min-w-[200px] max-w-[300px]">
      <div className="flex items-center gap-2.5">
        {/* Play/Pause */}
        <button
          onClick={toggle}
          className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${
            isMe
              ? "bg-white/20 hover:bg-white/30 text-white"
              : "bg-emerald-500 hover:bg-emerald-600 text-white"
          }`}
        >
          {playing ? (
            <Pause className="w-4 h-4 fill-current" />
          ) : (
            <Play className="w-4 h-4 fill-current ml-0.5" />
          )}
        </button>

        {/* Waveform */}
        <div className="flex-1 min-w-0">
          <div
            className="flex items-center gap-[2px] h-[28px] cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = (e.clientX - rect.left) / rect.width;
              seekFromBar(Math.round(x * BAR_COUNT));
            }}
          >
            {waveform.map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-full transition-colors duration-100"
                style={{
                  height: `${h * 100}%`,
                  minWidth: 2,
                  maxWidth: 4,
                  backgroundColor:
                    i < playedBars
                      ? isMe
                        ? "rgba(255,255,255,0.9)"
                        : "#10b981"
                      : isMe
                        ? "rgba(255,255,255,0.25)"
                        : "rgba(16,185,129,0.25)",
                }}
              />
            ))}
          </div>

          {/* Time + transcribe button */}
          <div className="flex items-center justify-between mt-0.5">
            <span
              className={`text-[10px] font-mono ${
                isMe ? "text-white/60" : "text-muted-foreground"
              }`}
            >
              {timeLabel}
            </span>
            {canTranscribe && (
              <button
                onClick={() => void transcribe()}
                disabled={transcribing}
                className={`text-[10px] flex items-center gap-0.5 transition-colors ${
                  isMe
                    ? "text-white/50 hover:text-white/80"
                    : "text-muted-foreground hover:text-foreground"
                } ${showTranscript ? (isMe ? "text-white/80" : "text-foreground") : ""}`}
                title="Транскрибация"
              >
                {transcribing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Type className="w-3 h-3" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Transcript text */}
      {showTranscript && transcript && (
        <div
          className={`mt-1.5 text-[11px] leading-relaxed rounded-lg px-2 py-1.5 ${
            isMe
              ? "bg-white/10 text-white/80"
              : "bg-muted/50 text-muted-foreground"
          }`}
        >
          {transcript}
        </div>
      )}
    </div>
  );
}
