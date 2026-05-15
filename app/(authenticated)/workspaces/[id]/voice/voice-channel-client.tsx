"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Mic,
  MicOff,
  PhoneOff,
  Monitor,
  MessageSquare,
  Plus,
  Settings,
  Link2,
  X,
  Volume2,
  Clock,
  Paperclip,
  Send,
  Trash2,
  Lock,
} from "lucide-react";
import { UserAvatar } from "@/components/ui/user-avatar";
import { toastSuccess } from "@/lib/toast";
import { useWebRTC } from "./use-webrtc";
import { useAudioRecorder } from "./use-audio-recorder";

/* ── Types ── */

type VoiceRoom = {
  id: string;
  name: string;
  isDefault: boolean;
  isPrivate: boolean;
  participantCount: number;
};

type Participant = {
  id: string;
  userId: string | null;
  guestName: string | null;
  isMuted: boolean;
  isScreenSharing: boolean;
  login: string | null;
  hasAvatar: boolean;
};

type VoiceMsg = {
  id: string;
  userId: string | null;
  guestName: string | null;
  content: string;
  createdAt: string;
  login: string | null;
  hasAvatar: boolean;
};

type VoiceSessionItem = {
  id: string;
  roomName: string;
  startedAt: string;
  endedAt: string | null;
  duration: number | null;
  participants: string;
  summary: string | null;
};

/* ── Helpers ── */

const AVATAR_COLORS = [
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
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/* ── Main Component ── */

type Props = {
  workspaceId: string;
  currentUserId: string;
  currentUserLogin: string;
};

export function VoiceChannelClient({
  workspaceId,
  currentUserId,
  currentUserLogin,
}: Props) {
  const qc = useQueryClient();
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [chatText, setChatText] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [newRoomName, setNewRoomName] = useState("");
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [isPrivateRoom, setIsPrivateRoom] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [viewSession, setViewSession] = useState<VoiceSessionItem | null>(null);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const speakingCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const { startRecording, stopRecording, addRemoteStream, removeRemoteStream } =
    useAudioRecorder();

  const base = `/api/workspaces/${workspaceId}/voice`;

  /* ── Rooms ── */
  const { data: rooms = [] } = useQuery<VoiceRoom[]>({
    queryKey: ["voice-rooms", workspaceId],
    queryFn: () => fetch(`${base}/rooms`).then((r) => r.json()),
    refetchInterval: 10_000,
  });

  // Auto-select first room
  useEffect(() => {
    if (!activeRoomId && rooms.length > 0) {
      const def = rooms.find((r) => r.isDefault) ?? rooms[0];
      if (def) setActiveRoomId(def.id);
    }
  }, [rooms, activeRoomId]);

  /* ── Participants ── */
  const { data: participants = [] } = useQuery<Participant[]>({
    queryKey: ["voice-participants", activeRoomId],
    queryFn: async () => {
      const res = await fetch(`${base}/rooms/${activeRoomId}/participants`);
      const raw = await res.json();
      return (
        raw as Array<{
          id: string;
          userId: string | null;
          guestName: string | null;
          isMuted: boolean;
          isScreenSharing: boolean;
          user: { id: string; login: string; avatarPath: string | null } | null;
        }>
      ).map((p) => ({
        id: p.id,
        userId: p.userId,
        guestName: p.guestName,
        isMuted: p.isMuted,
        isScreenSharing: p.isScreenSharing,
        login: p.user?.login ?? null,
        hasAvatar: !!p.user?.avatarPath,
      }));
    },
    enabled: !!activeRoomId,
    refetchInterval: connected ? 3000 : 10000,
  });

  // WebRTC hook (must be after participants query)
  const participantUserIds = participants
    .map((p) => p.userId)
    .filter((id): id is string => !!id);

  const signalBase = activeRoomId ? `${base}/rooms/${activeRoomId}` : "";
  const { remoteScreens } = useWebRTC({
    signalBase,
    currentUserId,
    connected,
    localStream,
    screenStream,
    peerUserIds: participantUserIds,
    onRemoteAudio: addRemoteStream,
    onPeerLeft: removeRemoteStream,
  });

  /* ── Messages ── */
  const { data: messages = [] } = useQuery<VoiceMsg[]>({
    queryKey: ["voice-messages", activeRoomId],
    queryFn: async () => {
      const res = await fetch(`${base}/rooms/${activeRoomId}/messages`);
      const raw = await res.json();
      return (
        raw as Array<{
          id: string;
          userId: string | null;
          guestName: string | null;
          content: string;
          createdAt: string;
          user: { login: string; avatarPath: string | null } | null;
        }>
      ).map((m) => ({
        id: m.id,
        userId: m.userId,
        guestName: m.guestName,
        content: m.content,
        createdAt: m.createdAt,
        login: m.user?.login ?? null,
        hasAvatar: !!m.user?.avatarPath,
      }));
    },
    enabled: !!activeRoomId && showChat,
    refetchInterval: connected ? 3000 : false,
  });

  /* ── Sessions ── */
  const { data: sessionsData } = useQuery<{ data: VoiceSessionItem[] }>({
    queryKey: ["voice-sessions", workspaceId],
    queryFn: () => fetch(`${base}/sessions`).then((r) => r.json()),
    staleTime: 30_000,
  });
  const sessions = sessionsData?.data ?? [];

  /* ── Workspace members (for private room creation) ── */
  type WsMember = { id: string; login: string; hasAvatar: boolean };
  const { data: wsMembers = [] } = useQuery<WsMember[]>({
    queryKey: ["ws-members-voice", workspaceId],
    queryFn: async () => {
      const res = await fetch(`/api/users/all`);
      return res.json();
    },
    staleTime: 60_000,
    enabled: showNewRoom,
  });

  /* ── Mutations ── */
  const joinMut = useMutation({
    mutationFn: () =>
      fetch(`${base}/rooms/${activeRoomId}/participants`, {
        method: "POST",
      }).then((r) => {
        if (!r.ok) throw new Error("Join failed");
        return r.json();
      }),
    onSuccess: () => {
      setConnected(true);
      setElapsed(0);
      void qc.invalidateQueries({
        queryKey: ["voice-participants", activeRoomId],
      });
      void qc.invalidateQueries({ queryKey: ["voice-rooms", workspaceId] });
      // Start mic + speaking detection
      void navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          setLocalStream(stream);
          // Start recording mixed audio for AI summary
          startRecording(stream);
          // AudioContext analyser for speaking detection
          try {
            const ctx = new AudioContext();
            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.5;
            src.connect(analyser);
            analyserRef.current = analyser;
            const dataArr = new Uint8Array(analyser.frequencyBinCount);
            speakingCheckRef.current = setInterval(() => {
              analyser.getByteFrequencyData(dataArr);
              const avg = dataArr.reduce((a, b) => a + b, 0) / dataArr.length;
              setIsSpeaking(avg > 15);
            }, 150);
          } catch {
            /* no AudioContext support */
          }
        })
        .catch(() => {});
    },
  });

  const leaveMut = useMutation({
    mutationFn: async () => {
      // 1. Stop recording and upload BEFORE leaving
      try {
        const blob = await stopRecording();
        if (blob && blob.size > 1000 && activeRoomId) {
          const fd = new FormData();
          fd.append(
            "file",
            new File([blob], "call-recording.webm", { type: blob.type }),
          );
          await fetch(`${base}/rooms/${activeRoomId}/recording`, {
            method: "POST",
            body: fd,
          });
        }
      } catch {
        /* silent */
      }
      // 2. Then leave the room
      await fetch(`${base}/rooms/${activeRoomId}/participants`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      setConnected(false);
      setIsMuted(false);
      setIsScreenSharing(false);
      setIsSpeaking(false);
      localStream?.getTracks().forEach((t) => t.stop());
      setLocalStream(null);
      screenStream?.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      if (speakingCheckRef.current) clearInterval(speakingCheckRef.current);
      void qc.invalidateQueries({
        queryKey: ["voice-participants", activeRoomId],
      });
      void qc.invalidateQueries({ queryKey: ["voice-rooms", workspaceId] });
      void qc.invalidateQueries({ queryKey: ["voice-sessions", workspaceId] });
    },
  });

  const createRoomMut = useMutation({
    mutationFn: (args: {
      name: string;
      isPrivate: boolean;
      allowedUserIds: string[];
    }) =>
      fetch(`${base}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      }),
    onSuccess: () => {
      setNewRoomName("");
      setShowNewRoom(false);
      void qc.invalidateQueries({ queryKey: ["voice-rooms", workspaceId] });
      toastSuccess("Канал создан");
    },
  });

  const deleteRoomMut = useMutation({
    mutationFn: (roomId: string) =>
      fetch(`${base}/rooms/${roomId}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["voice-rooms", workspaceId] });
      toastSuccess("Канал удалён");
    },
  });

  const renameRoomMut = useMutation({
    mutationFn: ({ roomId, name }: { roomId: string; name: string }) =>
      fetch(`${base}/rooms/${roomId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["voice-rooms", workspaceId] });
      setShowSettings(false);
      toastSuccess("Канал переименован");
    },
  });

  /* ── Heartbeat ── */
  useEffect(() => {
    if (!connected || !activeRoomId) return;
    heartbeatRef.current = setInterval(() => {
      void fetch(`${base}/rooms/${activeRoomId}/heartbeat`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isMuted, isScreenSharing }),
      });
    }, 5000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, [connected, activeRoomId, isMuted, isScreenSharing, base]);

  /* ── Timer ── */
  useEffect(() => {
    if (!connected) {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
      return;
    }
    elapsedRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [connected]);

  // Attach screen stream to video element
  useEffect(() => {
    if (screenVideoRef.current && screenStream && isScreenSharing) {
      screenVideoRef.current.srcObject = screenStream;
    }
  }, [isScreenSharing, screenStream]);

  /* ── Screen share toggle ── */
  async function toggleScreenShare() {
    if (isScreenSharing) {
      screenStream?.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      setIsScreenSharing(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        setScreenStream(stream);
        setIsScreenSharing(true);
        requestAnimationFrame(() => {
          if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
        });
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          setIsScreenSharing(false);
          setScreenStream(null);
        });
      } catch {
        // User cancelled
      }
    }
  }

  /* ── Mute toggle ── */
  function toggleMute() {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => {
        t.enabled = !newMuted;
      });
    }
  }

  /* ── Send chat message ── */
  async function sendChat() {
    const t = chatText.trim();
    if (!t || !activeRoomId) return;
    await fetch(`${base}/rooms/${activeRoomId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: t }),
    });
    setChatText("");
    void qc.invalidateQueries({ queryKey: ["voice-messages", activeRoomId] });
  }

  /* ── Copy invite link ── */
  async function copyInvite() {
    if (!activeRoomId) return;
    const r = await fetch(`${base}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: activeRoomId }),
    });
    const data = await r.json();
    await navigator.clipboard.writeText(data.url ?? window.location.href);
    toastSuccess("Ссылка скопирована");
  }

  const activeRoom = rooms.find((r) => r.id === activeRoomId);
  const displayName = (p: Participant) => p.login ?? p.guestName ?? "Гость";

  /* ── Render ── */
  return (
    <div className="flex flex-1 overflow-hidden min-h-0">
      {/* ═══ LEFT: Channels Sidebar ═══ */}
      <aside className="w-[240px] bg-card border-r border-border flex flex-col shrink-0 min-h-0">
        <div className="px-4 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-[13px] font-bold text-white flex items-center gap-2">
            <Volume2 className="h-4 w-4 opacity-50" />
            Голосовые каналы
          </h3>
          <button
            onClick={() => setShowNewRoom(true)}
            className="w-7 h-7 rounded-md border border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-white hover:border-emerald-500 flex items-center justify-center transition-all text-sm"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {/* New room form */}
        {showNewRoom && (
          <div className="px-3 pt-3 space-y-2">
            <input
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="Название канала..."
              className="w-full px-2.5 py-1.5 bg-muted border border-border rounded-lg text-xs text-foreground outline-none focus:border-emerald-500"
              autoFocus
            />
            {/* Private toggle */}
            <button
              onClick={() => setIsPrivateRoom((v) => !v)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] border transition-colors ${isPrivateRoom ? "border-emerald-500 bg-emerald-500/10 text-emerald-400" : "border-border text-muted-foreground hover:border-border"}`}
            >
              <Lock className="h-3 w-3" />
              {isPrivateRoom ? "Приватный канал" : "Сделать приватным"}
            </button>
            {/* Member selection for private */}
            {isPrivateRoom && (
              <div className="max-h-[120px] overflow-y-auto space-y-0.5 bg-muted/50 rounded-lg p-1.5">
                {wsMembers
                  .filter((m) => m.id !== currentUserId)
                  .map((m) => (
                    <label
                      key={m.id}
                      className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-muted/80 cursor-pointer text-[11px]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedMembers.includes(m.id)}
                        onChange={(e) =>
                          setSelectedMembers((prev) =>
                            e.target.checked
                              ? [...prev, m.id]
                              : prev.filter((id) => id !== m.id),
                          )
                        }
                        className="w-3 h-3 rounded accent-emerald-500"
                      />
                      <UserAvatar
                        userId={m.hasAvatar ? m.id : undefined}
                        login={m.login}
                        size={18}
                      />
                      <span className="text-foreground">{m.login}</span>
                    </label>
                  ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <button
                onClick={() => {
                  if (newRoomName.trim()) {
                    createRoomMut.mutate({
                      name: newRoomName.trim(),
                      isPrivate: isPrivateRoom,
                      allowedUserIds: selectedMembers,
                    });
                    setIsPrivateRoom(false);
                    setSelectedMembers([]);
                  }
                }}
                disabled={!newRoomName.trim()}
                className="flex-1 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white rounded-lg text-[11px] font-medium transition-colors"
              >
                Создать
              </button>
              <button
                onClick={() => {
                  setShowNewRoom(false);
                  setIsPrivateRoom(false);
                  setSelectedMembers([]);
                  setNewRoomName("");
                }}
                className="px-3 py-1.5 text-muted-foreground hover:text-foreground text-[11px] rounded-lg hover:bg-muted transition-colors"
              >
                Отмена
              </button>
            </div>
          </div>
        )}

        {/* Room list */}
        <div className="flex-1 overflow-y-auto py-2">
          {rooms.map((room) => (
            <div key={room.id}>
              <div
                onClick={() => {
                  if (!connected) setActiveRoomId(room.id);
                }}
                className={`flex items-center gap-2 px-3 py-2 mx-2 rounded-lg cursor-pointer text-[13px] transition-colors ${room.id === activeRoomId ? "bg-emerald-500/10 text-emerald-400" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
              >
                {room.isDefault ? (
                  <Volume2 className="h-4 w-4 shrink-0 opacity-60" />
                ) : (
                  <Lock className="h-4 w-4 shrink-0 opacity-60" />
                )}
                <span className="flex-1 truncate">{room.name}</span>
                {room.participantCount > 0 && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full ${room.id === activeRoomId ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground/70"}`}
                  >
                    {room.participantCount}
                  </span>
                )}
                {!room.isDefault && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Удалить канал?"))
                        deleteRoomMut.mutate(room.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground/70 hover:text-red-400 p-0.5"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
              {/* Show participants nested */}
              {room.id === activeRoomId && participants.length > 0 && (
                <div className="pl-10 pr-3 pb-1 space-y-0.5">
                  {participants.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground"
                    >
                      <div
                        className={`w-5 h-5 rounded-full flex items-center justify-center text-[7px] font-bold text-white shrink-0 ${p.userId === currentUserId && isSpeaking && !p.isMuted ? "ring-2 ring-emerald-500" : ""}`}
                        style={{ background: colorFor(displayName(p)) }}
                      >
                        {displayName(p)[0]?.toUpperCase()}
                      </div>
                      <span
                        className={`truncate ${p.userId === currentUserId && isSpeaking && !p.isMuted ? "text-emerald-400" : ""}`}
                      >
                        {displayName(p)}
                      </span>
                      {p.isMuted && (
                        <MicOff className="h-3 w-3 text-muted-foreground/70 ml-auto" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* History */}
        {sessions.length > 0 && (
          <div className="border-t border-border pb-2">
            <div className="text-[9px] font-bold text-muted-foreground/70 uppercase tracking-widest px-4 pt-3 pb-1">
              История звонков
            </div>
            {sessions.slice(0, 5).map((s) => (
              <div
                key={s.id}
                onClick={() => setViewSession(s)}
                className="flex items-center gap-2 px-4 py-1.5 hover:bg-muted/50 rounded-lg mx-2 cursor-pointer"
              >
                <Clock className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-foreground truncate">
                    {s.roomName} · {s.duration ? fmtDuration(s.duration) : "—"}
                  </div>
                  <div className="text-[9px] text-muted-foreground/70">
                    {format(new Date(s.startedAt), "d MMM, HH:mm", {
                      locale: ru,
                    })}
                  </div>
                </div>
                {s.summary && (
                  <span className="text-[8px] text-[#8b5cf6] bg-[#8b5cf6]/10 px-1.5 py-0.5 rounded font-semibold shrink-0">
                    AI
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* ═══ CENTER: Channel View ═══ */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border bg-card flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <Volume2 className="h-5 w-5 text-emerald-500" />
            <h2 className="text-[15px] font-bold text-white">
              {activeRoom?.name ?? "Голосовой канал"}
            </h2>
            {connected && (
              <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full font-semibold">
                Подключено
              </span>
            )}
          </div>
          <div className="flex gap-1.5">
            {connected && participants.some((p) => p.isScreenSharing) && (
              <button className="w-8 h-8 rounded-lg border border-blue-500 bg-blue-500/15 text-blue-400 flex items-center justify-center">
                <Monitor className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => void copyInvite()}
              className="w-8 h-8 rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-emerald-400 hover:border-emerald-500 flex items-center justify-center transition-colors"
              title="Пригласить по ссылке"
            >
              <Link2 className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                setRenameValue(activeRoom?.name ?? "");
                setShowSettings(true);
              }}
              className="w-8 h-8 rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-white flex items-center justify-center transition-colors"
              title="Настройки"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Screen share preview */}
        {isScreenSharing && (
          <div className="mx-6 mt-4 bg-card border border-border rounded-xl overflow-hidden shrink-0">
            <div className="px-3 py-2 border-b border-border flex items-center gap-2 text-[11px] text-muted-foreground">
              <Monitor className="h-3.5 w-3.5 text-blue-400" />
              <b className="text-blue-400">{currentUserLogin}</b> демонстрирует
              экран
              <button
                onClick={() => void toggleScreenShare()}
                className="ml-auto text-[10px] text-red-400 hover:text-red-300 transition-colors"
              >
                Остановить
              </button>
            </div>
            <video
              ref={screenVideoRef}
              autoPlay
              muted
              playsInline
              className="w-full max-h-[280px] object-contain bg-black"
            />
          </div>
        )}

        {/* Remote screen shares */}
        {remoteScreens.map((rs) => {
          const sharer = participants.find((p) => p.userId === rs.userId);
          const sharerName = sharer?.login ?? "Участник";
          return (
            <div
              key={rs.userId}
              className="mx-6 mt-4 bg-card border border-border rounded-xl overflow-hidden shrink-0"
            >
              <div className="px-3 py-2 border-b border-border flex items-center gap-2 text-[11px] text-muted-foreground">
                <Monitor className="h-3.5 w-3.5 text-blue-400" />
                <b className="text-blue-400">{sharerName}</b> демонстрирует
                экран
              </div>
              <RemoteVideo stream={rs.stream} />
            </div>
          );
        })}

        {/* Participants area */}
        <div
          className={`flex-1 overflow-y-auto flex flex-wrap items-center justify-center gap-5 p-6 bg-background content-center ${isScreenSharing || remoteScreens.length > 0 ? "min-h-[120px]" : ""}`}
        >
          {!connected && participants.length === 0 && (
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
                <Volume2 className="h-8 w-8 text-muted-foreground/50" />
              </div>
              <p className="text-muted-foreground/70 text-sm mb-4">
                Никого нет в канале
              </p>
              <button
                onClick={() => joinMut.mutate()}
                disabled={joinMut.isPending}
                className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-sm font-medium transition-colors"
              >
                Присоединиться
              </button>
            </div>
          )}
          {!connected && participants.length > 0 && (
            <div className="text-center">
              <p className="text-muted-foreground text-sm mb-4">
                {participants.length} в канале
              </p>
              <button
                onClick={() => joinMut.mutate()}
                disabled={joinMut.isPending}
                className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-sm font-medium transition-colors"
              >
                Присоединиться
              </button>
            </div>
          )}
          {connected &&
            participants.map((p) => {
              const name = displayName(p);
              const isMe = p.userId === currentUserId;
              const vol = volumes[p.id] ?? 100;
              return (
                <div
                  key={p.id}
                  className={`w-[170px] flex flex-col items-center gap-2 p-5 rounded-2xl border transition-all group relative bg-card ${isMe && isSpeaking && !isMuted ? "border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.15)]" : "border-border/40 hover:border-border/60"}`}
                >
                  {/* Mute badge */}
                  {p.isMuted && (
                    <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-red-500 flex items-center justify-center z-10">
                      <MicOff className="h-3 w-3 text-white" />
                    </div>
                  )}
                  {/* Avatar */}
                  <div
                    className={`rounded-full ${isMe && isSpeaking && !isMuted ? "ring-[3px] ring-emerald-500 ring-offset-2 ring-offset-card" : ""}`}
                  >
                    {p.hasAvatar && p.userId ? (
                      <UserAvatar userId={p.userId} login={name} size={64} />
                    ) : (
                      <div
                        className="w-16 h-16 rounded-full flex items-center justify-center text-[22px] font-bold text-white"
                        style={{ background: colorFor(name) }}
                      >
                        {name[0]?.toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="text-[13px] font-semibold text-foreground truncate max-w-full">
                    {name}
                  </div>
                  {!p.userId && (
                    <span className="text-[9px] text-[#f59e0b] bg-[#f59e0b]/10 px-1.5 py-0.5 rounded font-semibold">
                      Гость
                    </span>
                  )}
                  {p.isScreenSharing && (
                    <span className="text-[9px] text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded font-semibold flex items-center gap-1">
                      <Monitor className="h-3 w-3" /> Экран
                    </span>
                  )}
                  {/* Volume slider */}
                  {!isMe && (
                    <div className="flex items-center gap-1.5 w-full mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Volume2 className="h-3 w-3 text-muted-foreground/70 shrink-0" />
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={vol}
                        onChange={(e) =>
                          setVolumes((v) => ({
                            ...v,
                            [p.id]: Number(e.target.value),
                          }))
                        }
                        className="flex-1 min-w-0 h-1 appearance-none bg-border rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:cursor-pointer"
                      />
                      <span className="text-[9px] text-muted-foreground/70 min-w-[28px] text-right shrink-0">
                        {vol}%
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        {/* Controls */}
        {connected && (
          <div className="px-6 py-4 border-t border-border bg-card flex items-center justify-center gap-3 relative">
            {/* Timer */}
            <div className="absolute left-6 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {fmtDuration(elapsed)}
            </div>

            <button
              onClick={toggleMute}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${isMuted ? "bg-red-500 text-white" : "bg-muted text-emerald-400 hover:bg-muted"}`}
              title={isMuted ? "Включить микрофон" : "Выключить микрофон"}
            >
              {isMuted ? (
                <MicOff className="h-5 w-5" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </button>

            <button
              onClick={() => void toggleScreenShare()}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${isScreenSharing ? "bg-blue-500 text-white" : "bg-muted text-muted-foreground hover:text-blue-400 hover:bg-muted"}`}
              title={
                isScreenSharing
                  ? "Остановить демонстрацию"
                  : "Демонстрация экрана"
              }
            >
              <Monitor className="h-5 w-5" />
            </button>

            <button
              onClick={() => setShowChat((v) => !v)}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${showChat ? "bg-muted text-foreground" : "bg-muted text-muted-foreground hover:bg-muted"}`}
              title="Чат канала"
            >
              <MessageSquare className="h-5 w-5" />
            </button>

            <div className="w-px h-7 bg-border mx-1" />

            <button
              onClick={() => leaveMut.mutate()}
              className="w-11 h-11 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-colors"
              title="Отключиться"
            >
              <PhoneOff className="h-5 w-5" />
            </button>
          </div>
        )}
      </div>

      {/* ═══ RIGHT: Voice Chat Panel ═══ */}
      {showChat && connected && (
        <aside className="w-[320px] bg-card border-l border-border flex flex-col shrink-0 min-h-0">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <span className="text-[13px] font-bold text-white">Чат канала</span>
            <button
              onClick={() => setShowChat(false)}
              className="w-7 h-7 rounded-md text-muted-foreground hover:text-white hover:bg-muted flex items-center justify-center"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((m) => {
              const name = m.login ?? m.guestName ?? "Гость";
              return (
                <div key={m.id}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[7px] font-bold text-white"
                      style={{ background: colorFor(name) }}
                    >
                      {name[0]?.toUpperCase()}
                    </div>
                    <span className="text-[11px] font-semibold text-foreground">
                      {name}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70">
                      {format(new Date(m.createdAt), "HH:mm")}
                    </span>
                  </div>
                  <div className="text-[12px] text-muted-foreground pl-[26px] leading-relaxed">
                    {m.content}
                  </div>
                </div>
              );
            })}
            {messages.length === 0 && (
              <p className="text-[12px] text-muted-foreground/70 text-center py-8">
                Нет сообщений
              </p>
            )}
          </div>

          <div className="px-4 py-3 border-t border-border">
            <div className="bg-muted border border-border rounded-xl px-3 py-2 flex items-center gap-2 focus-within:border-emerald-500">
              <button className="text-muted-foreground hover:text-muted-foreground shrink-0">
                <Paperclip className="h-3.5 w-3.5" />
              </button>
              <input
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendChat();
                  }
                }}
                placeholder="Напишите в чат канала..."
                className="flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
              {chatText.trim() && (
                <button
                  onClick={() => void sendChat()}
                  className="w-7 h-7 rounded-lg bg-emerald-500 text-white flex items-center justify-center shrink-0"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </aside>
      )}

      {/* ═══ Session Summary Modal ═══ */}
      {viewSession && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setViewSession(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl p-6 w-full max-w-[500px] shadow-2xl max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-foreground">
                Сводка звонка
              </h3>
              <button
                onClick={() => setViewSession(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3 mb-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Канал</span>
                <span className="text-foreground font-medium">
                  {viewSession.roomName}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Дата</span>
                <span className="text-foreground">
                  {format(
                    new Date(viewSession.startedAt),
                    "d MMM yyyy, HH:mm",
                    { locale: ru },
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Длительность</span>
                <span className="text-foreground">
                  {viewSession.duration
                    ? fmtDuration(viewSession.duration)
                    : "—"}
                </span>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Участники: </span>
                <span className="text-foreground">
                  {(() => {
                    try {
                      const p = JSON.parse(viewSession.participants) as Array<{
                        login?: string;
                        guestName?: string;
                      }>;
                      return (
                        p
                          .map((x) => x.login ?? x.guestName ?? "Гость")
                          .join(", ") || "—"
                      );
                    } catch {
                      return "—";
                    }
                  })()}
                </span>
              </div>
            </div>

            {viewSession.summary ? (
              <div className="p-4 bg-muted/50 rounded-xl border border-border">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] text-purple-500 bg-purple-500/10 px-2 py-0.5 rounded font-semibold">
                    AI Саммари
                  </span>
                </div>
                <div className="text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed">
                  {viewSession.summary}
                </div>
              </div>
            ) : (
              <div className="p-4 bg-muted/50 rounded-xl text-center">
                <p className="text-sm text-muted-foreground">
                  Саммари ещё не сгенерировано
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ Settings Modal ═══ */}
      {showSettings && activeRoom && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="bg-card border border-border rounded-2xl p-6 w-full max-w-[400px] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-foreground">
                Настройки канала
              </h3>
              <button
                onClick={() => setShowSettings(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Rename */}
            <div className="mb-4">
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Название канала
              </label>
              <div className="flex gap-2">
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="flex-1 px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-emerald-500"
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      renameValue.trim() &&
                      renameValue !== activeRoom.name
                    )
                      renameRoomMut.mutate({
                        roomId: activeRoom.id,
                        name: renameValue.trim(),
                      });
                  }}
                />
                <button
                  onClick={() => {
                    if (renameValue.trim() && renameValue !== activeRoom.name)
                      renameRoomMut.mutate({
                        roomId: activeRoom.id,
                        name: renameValue.trim(),
                      });
                  }}
                  disabled={
                    !renameValue.trim() || renameValue === activeRoom.name
                  }
                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Сохранить
                </button>
              </div>
            </div>

            {/* Info */}
            <div className="mb-4 p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Тип</span>
                <span className="text-foreground">
                  {activeRoom.isDefault ? "Общая (по умолчанию)" : "Приватная"}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm mt-2">
                <span className="text-muted-foreground">Участников</span>
                <span className="text-foreground">{participants.length}</span>
              </div>
            </div>

            {/* Delete */}
            {!activeRoom.isDefault && (
              <button
                onClick={() => {
                  if (confirm(`Удалить канал "${activeRoom.name}"?`)) {
                    deleteRoomMut.mutate(activeRoom.id);
                    setShowSettings(false);
                    setActiveRoomId(rooms.find((r) => r.isDefault)?.id ?? null);
                  }
                }}
                className="w-full py-2.5 border border-red-500/30 text-red-500 hover:bg-red-500/10 rounded-lg text-sm font-medium transition-colors"
              >
                Удалить канал
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Remote Video (attaches stream to video element) ── */

function RemoteVideo({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      className="w-full max-h-[280px] object-contain bg-black"
    />
  );
}
