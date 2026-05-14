"use client";

import { useState, useRef, useEffect } from "react";
import {
  Volume2,
  Mic,
  MicOff,
  PhoneOff,
  MessageSquare,
  Send,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { WorkspaceLogo } from "@/components/ui/workspace-logo";

type Participant = {
  id: string;
  userId: string | null;
  guestName: string | null;
  isMuted: boolean;
  login: string | null;
};

type VoiceMsg = {
  id: string;
  guestName: string | null;
  content: string;
  createdAt: string;
  login: string | null;
};

const COLORS = [
  "#10b981",
  "#ef4444",
  "#f59e0b",
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];
function colorFor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length]!;
}

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

type Props = {
  workspaceId: string;
  roomId: string;
  roomName: string;
  workspaceName: string;
  hasLogo: boolean;
  token: string;
};

export function GuestJoinClient({
  workspaceId,
  roomId,
  roomName,
  workspaceName,
  hasLogo,
  token,
}: Props) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [chatText, setChatText] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [guestToken] = useState(token || crypto.randomUUID());
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const base = `/api/workspaces/${workspaceId}/voice/rooms/${roomId}`;

  /* ── Participants ── */
  const { data: participants = [] } = useQuery<Participant[]>({
    queryKey: ["voice-guest-participants", roomId],
    queryFn: async () => {
      const res = await fetch(`${base}/participants`);
      if (!res.ok) return [];
      const raw = await res.json();
      return (
        raw as Array<{
          id: string;
          userId: string | null;
          guestName: string | null;
          isMuted: boolean;
          user: { login: string } | null;
        }>
      ).map((p) => ({
        id: p.id,
        userId: p.userId,
        guestName: p.guestName,
        isMuted: p.isMuted,
        login: p.user?.login ?? null,
      }));
    },
    refetchInterval: joined ? 3000 : 10000,
  });

  /* ── Messages ── */
  const { data: messages = [] } = useQuery<VoiceMsg[]>({
    queryKey: ["voice-guest-messages", roomId],
    queryFn: async () => {
      const res = await fetch(`${base}/messages`);
      if (!res.ok) return [];
      const raw = await res.json();
      return (
        raw as Array<{
          id: string;
          guestName: string | null;
          content: string;
          createdAt: string;
          user: { login: string } | null;
        }>
      ).map((m) => ({
        id: m.id,
        guestName: m.guestName,
        content: m.content,
        createdAt: m.createdAt,
        login: m.user?.login ?? null,
      }));
    },
    enabled: joined && showChat,
    refetchInterval: 3000,
  });

  /* ── Join ── */
  async function handleJoin() {
    if (!name.trim()) return;
    setJoining(true);
    try {
      const res = await fetch(`${base}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestName: name.trim(), guestToken }),
      });
      if (res.ok) {
        setJoined(true);
        setElapsed(0);
        // Start mic
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          mediaStreamRef.current = stream;
        } catch {
          /* mic denied */
        }
      }
    } finally {
      setJoining(false);
    }
  }

  /* ── Leave ── */
  function handleLeave() {
    void fetch(`${base}/participants`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guestToken }),
    });
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    setJoined(false);
    setIsMuted(false);
  }

  /* ── Heartbeat ── */
  useEffect(() => {
    if (!joined) return;
    heartbeatRef.current = setInterval(() => {
      void fetch(`${base}/heartbeat`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isMuted, guestToken }),
      });
    }, 5000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, [joined, isMuted, base, guestToken]);

  /* ── Timer ── */
  useEffect(() => {
    if (!joined) {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
      return;
    }
    elapsedRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [joined]);

  /* ── Mute ── */
  function toggleMute() {
    const m = !isMuted;
    setIsMuted(m);
    mediaStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !m;
    });
  }

  /* ── Send chat ── */
  async function sendChat() {
    const t = chatText.trim();
    if (!t) return;
    await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: t, guestName: name }),
    });
    setChatText("");
    void qc.invalidateQueries({ queryKey: ["voice-guest-messages", roomId] });
  }

  const displayName = (p: Participant) => p.login ?? p.guestName ?? "Гость";

  /* ── Join screen ── */
  if (!joined) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 w-full max-w-[380px] text-center">
          <div className="flex items-center justify-center gap-2 text-gray-500 text-sm mb-4">
            <WorkspaceLogo
              workspaceId={workspaceId}
              name={workspaceName}
              hasLogo={hasLogo}
              size={24}
              className="rounded-md"
            />
            {workspaceName} · {roomName}
          </div>
          <h2 className="text-xl font-bold text-white mb-1">
            Присоединиться к звонку
          </h2>
          <p className="text-sm text-gray-500 mb-5">
            Введите ваше имя, чтобы подключиться
          </p>

          {participants.length > 0 && (
            <div className="flex items-center justify-center gap-1 mb-4">
              {participants.slice(0, 5).map((p) => (
                <div
                  key={p.id}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                  style={{ background: colorFor(displayName(p)) }}
                >
                  {displayName(p)[0]?.toUpperCase()}
                </div>
              ))}
              <span className="text-xs text-gray-500 ml-2">
                {participants.length} в канале
              </span>
            </div>
          )}

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleJoin();
            }}
            placeholder="Ваше имя"
            className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-xl text-white text-sm outline-none placeholder:text-gray-600 focus:border-emerald-500 transition-colors mb-3"
            autoFocus
          />
          <button
            onClick={() => void handleJoin()}
            disabled={!name.trim() || joining}
            className="w-full py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors"
          >
            {joining ? "Подключение..." : "Присоединиться"}
          </button>
        </div>
      </div>
    );
  }

  /* ── Connected view ── */
  return (
    <div className="h-screen bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-800 bg-gray-900 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Volume2 className="h-5 w-5 text-emerald-500" />
          <h2 className="text-[15px] font-bold text-white">{roomName}</h2>
          <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full font-semibold">
            Гость: {name}
          </span>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Participants */}
        <div className="flex-1 overflow-y-auto flex flex-wrap items-center justify-center gap-5 p-6 content-center">
          {participants.map((p) => {
            const dn = displayName(p);
            return (
              <div
                key={p.id}
                className="w-[160px] flex flex-col items-center gap-2 p-5 bg-gray-900 rounded-2xl border border-gray-800 relative"
              >
                {p.isMuted && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
                    <MicOff className="h-3 w-3 text-white" />
                  </div>
                )}
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold text-white"
                  style={{ background: colorFor(dn) }}
                >
                  {dn[0]?.toUpperCase()}
                </div>
                <div className="text-sm font-semibold text-gray-300 truncate max-w-full">
                  {dn}
                </div>
                {!p.userId && (
                  <span className="text-[9px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded font-semibold">
                    Гость
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Chat */}
        {showChat && (
          <aside className="w-[300px] bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 min-h-0">
            <div className="px-4 py-3 border-b border-gray-800 text-sm font-bold text-white">
              Чат
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messages.map((m) => {
                const dn = m.login ?? m.guestName ?? "Гость";
                return (
                  <div key={m.id}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <div
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[7px] font-bold text-white"
                        style={{ background: colorFor(dn) }}
                      >
                        {dn[0]?.toUpperCase()}
                      </div>
                      <span className="text-[11px] font-semibold text-gray-300">
                        {dn}
                      </span>
                      <span className="text-[10px] text-gray-600">
                        {format(new Date(m.createdAt), "HH:mm")}
                      </span>
                    </div>
                    <div className="text-[12px] text-gray-400 pl-[26px]">
                      {m.content}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-3 border-t border-gray-800">
              <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 flex items-center gap-2 focus-within:border-emerald-500">
                <input
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void sendChat();
                  }}
                  placeholder="Сообщение..."
                  className="flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-gray-600"
                />
                {chatText.trim() && (
                  <button
                    onClick={() => void sendChat()}
                    className="w-6 h-6 rounded-md bg-emerald-500 text-white flex items-center justify-center"
                  >
                    <Send className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* Controls */}
      <div className="px-6 py-4 border-t border-gray-800 bg-gray-900 flex items-center justify-center gap-3 relative">
        <div className="absolute left-6 flex items-center gap-1.5 text-[11px] text-gray-600">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {fmtDuration(elapsed)}
        </div>

        <button
          onClick={toggleMute}
          className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${isMuted ? "bg-red-500 text-white" : "bg-gray-800 text-emerald-400 hover:bg-gray-700"}`}
        >
          {isMuted ? (
            <MicOff className="h-5 w-5" />
          ) : (
            <Mic className="h-5 w-5" />
          )}
        </button>

        <button
          onClick={() => setShowChat((v) => !v)}
          className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${showChat ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-500 hover:bg-gray-700"}`}
        >
          <MessageSquare className="h-5 w-5" />
        </button>

        <div className="w-px h-7 bg-gray-800 mx-1" />

        <button
          onClick={handleLeave}
          className="w-11 h-11 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-colors"
        >
          <PhoneOff className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
