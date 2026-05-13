"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Mic, Square } from "lucide-react";

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
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        const ext = mr.mimeType.includes("webm") ? "webm" : "m4a";
        const file = new File([blob], `voice-${Date.now()}.${ext}`, {
          type: mr.mimeType,
        });
        onRecorded(file);
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

  const stop = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  if (recording) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-red-500 text-xs animate-pulse">
          <div className="w-2 h-2 bg-red-500 rounded-full" />
          {fmt(duration)}
        </div>
        <button
          onClick={stop}
          className="w-9 h-9 rounded-xl bg-red-500 hover:bg-red-600 flex items-center justify-center shrink-0"
          title="Остановить запись"
        >
          <Square className="w-4 h-4 text-white fill-white" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => void start()}
      disabled={disabled}
      className="w-9 h-9 rounded-lg hover:bg-gray-100 flex items-center justify-center shrink-0 disabled:opacity-40"
      title="Голосовое сообщение"
    >
      <Mic className="w-5 h-5 text-gray-400" />
    </button>
  );
}

export function VoicePlayer({ src, isMe }: { src: string; isMe: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dur, setDur] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Cleanup on unmount
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
        className={`text-[10px] shrink-0 ${isMe ? "text-white/60" : "text-gray-400"}`}
      >
        {fmt(dur || 0)}
      </span>
    </div>
  );
}
