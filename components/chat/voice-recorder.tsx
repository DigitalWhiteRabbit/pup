"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Mic, Square, X, Send } from "lucide-react";

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
    // Clear chunks so onstop won't call onRecorded
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

export function VoicePlayer({ src, isMe }: { src: string; isMe: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dur, setDur] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.onloadedmetadata = null;
        audioRef.current.ontimeupdate = null;
        audioRef.current.onended = null;
        audioRef.current = null;
      }
    };
  }, []);

  const toggle = () => {
    if (!audioRef.current) {
      const a = new Audio(src);
      audioRef.current = a;
      a.onloadedmetadata = () => setDur(Math.floor(a.duration));
      a.ontimeupdate = () =>
        setProgress(a.duration ? a.currentTime / a.duration : 0);
      a.onended = () => {
        setPlaying(false);
        setProgress(0);
      };
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      void audioRef.current.play();
      setPlaying(true);
    }
  };

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <button
        onClick={toggle}
        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
          isMe
            ? "bg-white/20 text-white"
            : "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400"
        }`}
      >
        {playing ? (
          <Square className="w-3 h-3 fill-current" />
        ) : (
          <svg className="w-3 h-3 fill-current ml-0.5" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-[60px]">
        <div
          className={`h-1 rounded-full ${isMe ? "bg-white/20" : "bg-muted"}`}
        >
          <div
            className={`h-1 rounded-full transition-all ${isMe ? "bg-white" : "bg-emerald-500"}`}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
      <span
        className={`text-[10px] shrink-0 ${isMe ? "text-white/60" : "text-muted-foreground"}`}
      >
        {fmt(dur || 0)}
      </span>
    </div>
  );
}
