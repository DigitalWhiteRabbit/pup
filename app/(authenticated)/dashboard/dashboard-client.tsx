"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import {
  MessageSquare,
  ListTodo,
  Ticket,
  ArrowRight,
  Send,
} from "lucide-react";
import { UserAvatar } from "@/components/ui/user-avatar";
import { WorkspaceLogo } from "@/components/ui/workspace-logo";
import { VoiceRecorder, VoicePlayer } from "@/components/chat/voice-recorder";

type WsStats = {
  id: string;
  name: string;
  hasLogo: boolean;
  role: string;
  openTickets: number;
  unreadChat: number;
  activeTasks: number;
};

type TaskItem = {
  id: string;
  title: string;
  priority: string;
  workspaceId: string;
  workspaceName: string;
};

type LogItem = {
  id: string;
  action: string;
  entityType: string;
  summary: string;
  createdAt: string;
  userLogin: string;
  workspaceName: string;
};

type GlobalChatMsg = {
  id: string;
  authorId: string;
  authorLogin: string;
  authorHasAvatar: boolean;
  content: string;
  createdAt: string;
  audioAttachmentId: string | null;
};

type DashboardData = {
  workspaces: WsStats[];
  myTasks: TaskItem[];
  recentLogs: LogItem[];
  globalChat: {
    unread: number;
    lastMessages: GlobalChatMsg[];
  };
};

function priorityDot(p: string) {
  if (p === "HIGH" || p === "URGENT") return "bg-red-500";
  if (p === "MEDIUM") return "bg-amber-500";
  return "bg-emerald-500";
}

function logDot(action: string) {
  if (action === "DELETE" || action === "REMOVE") return "bg-red-500";
  if (action === "CREATE" || action === "ADD") return "bg-emerald-500";
  if (action === "MOVE" || action === "ASSIGN") return "bg-amber-500";
  return "bg-blue-500";
}

function logText(l: LogItem): string {
  if (l.summary) return l.summary;
  return `${l.action} ${l.entityType}`;
}

export function DashboardClient() {
  const qc = useQueryClient();
  const { data } = useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: () => fetch("/api/dashboard").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const workspaces = data?.workspaces ?? [];
  const myTasks = data?.myTasks ?? [];
  const recentLogs = data?.recentLogs ?? [];
  const globalChat = data?.globalChat;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 text-foreground">Главная</h1>

      <div className="grid grid-cols-3 gap-5">
        {/* ═══ PROJECTS ═══ */}
        <div className="rounded-xl border bg-card p-5">
          <h2 className="text-[15px] font-semibold text-foreground mb-3">
            Мои проекты
          </h2>
          <div className="space-y-3">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="flex items-center gap-3 p-3 rounded-lg border bg-background"
              >
                <Link
                  href={`/workspaces/${ws.id}/dashboard`}
                  className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity"
                >
                  <WorkspaceLogo
                    workspaceId={ws.id}
                    name={ws.name}
                    hasLogo={ws.hasLogo}
                    size={40}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground truncate">
                      {ws.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {ws.role}
                    </div>
                  </div>
                </Link>
                <div className="flex gap-2 shrink-0">
                  <StatBadge
                    href={`/workspaces/${ws.id}/tickets?status=OPEN`}
                    icon={<Ticket className="h-3 w-3" />}
                    value={ws.openTickets}
                    color="text-amber-500"
                  />
                  <StatBadge
                    href={`/workspaces/${ws.id}/chat`}
                    icon={<MessageSquare className="h-3 w-3" />}
                    value={ws.unreadChat}
                    color="text-emerald-500"
                  />
                  <StatBadge
                    href={`/workspaces/${ws.id}/crm`}
                    icon={<ListTodo className="h-3 w-3" />}
                    value={ws.activeTasks}
                    color="text-indigo-500"
                  />
                </div>
              </div>
            ))}
            {workspaces.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">
                Нет проектов
              </div>
            )}
          </div>
          <Link
            href="/workspaces"
            className="inline-flex items-center gap-1 text-[11px] text-emerald-500 mt-3 hover:underline"
          >
            Все проекты <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {/* ═══ GUEST CHAT ═══ */}
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[15px] font-semibold text-foreground">
              Гостевой чат
            </h2>
            <Link
              href="/global-chat"
              className="text-[10px] text-emerald-500 hover:underline flex items-center gap-1"
            >
              Перейти <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="space-y-2">
            {(globalChat?.lastMessages ?? []).map((m) => (
              <div key={m.id} className="flex gap-2 items-start">
                <UserAvatar
                  userId={m.authorHasAvatar ? m.authorId : undefined}
                  login={m.authorLogin}
                  size={28}
                />
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold text-muted-foreground">
                    {m.authorLogin}
                  </div>
                  <div className="text-xs text-card-foreground bg-muted rounded-lg px-2.5 py-1.5 max-w-[260px]">
                    {m.audioAttachmentId ? (
                      <VoicePlayer
                        src={`/api/global-chat-attachments/${m.audioAttachmentId}`}
                        isMe={false}
                      />
                    ) : (
                      m.content
                    )}
                  </div>
                  <div className="text-[9px] text-muted-foreground mt-0.5">
                    {format(new Date(m.createdAt), "HH:mm", { locale: ru })}
                  </div>
                </div>
              </div>
            ))}
            {(globalChat?.lastMessages ?? []).length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">
                Нет сообщений
              </div>
            )}
          </div>
          <GlobalChatInput
            onSent={() =>
              void qc.invalidateQueries({ queryKey: ["dashboard"] })
            }
          />
        </div>

        {/* ═══ MY TASKS ═══ */}
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[15px] font-semibold text-foreground">
              Мои задачи
            </h2>
            {myTasks.length > 0 && (
              <span className="bg-amber-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                {myTasks.length}
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {myTasks.map((t) => (
              <Link
                key={t.id}
                href={`/workspaces/${t.workspaceId}/crm?taskId=${t.id}`}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border bg-background hover:border-emerald-500 transition-colors"
              >
                <div
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${priorityDot(t.priority)}`}
                />
                <span className="text-xs text-card-foreground flex-1 truncate">
                  {t.title}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {t.workspaceName}
                </span>
              </Link>
            ))}
            {myTasks.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">
                Нет задач
              </div>
            )}
          </div>
          <Link
            href="/workspaces"
            className="inline-flex items-center gap-1 text-[11px] text-emerald-500 mt-3 hover:underline"
          >
            Все задачи <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {/* ═══ RECENT LOGS ═══ */}
        <div className="rounded-xl border bg-card p-5">
          <h2 className="text-[15px] font-semibold text-foreground mb-3">
            Последние события
          </h2>
          <div className="space-y-0.5">
            {recentLogs.map((l) => (
              <div
                key={l.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-[11px] text-muted-foreground"
              >
                <div
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${logDot(l.action)}`}
                />
                <span className="flex-1 truncate">
                  <b className="text-card-foreground">{l.userLogin}</b>{" "}
                  {logText(l)}
                </span>
                <span className="text-[10px] shrink-0">
                  {l.workspaceName && <>{l.workspaceName} &middot; </>}
                  {format(new Date(l.createdAt), "HH:mm", { locale: ru })}
                </span>
              </div>
            ))}
            {recentLogs.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">
                Нет событий
              </div>
            )}
          </div>
          <Link
            href="/logs"
            className="inline-flex items-center gap-1 text-[11px] text-emerald-500 mt-3 hover:underline"
          >
            Все логи <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function StatBadge({
  href,
  icon,
  value,
  color,
}: {
  href: string;
  icon: React.ReactNode;
  value: number;
  color: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center bg-muted rounded-md px-2 py-1 min-w-[36px] hover:bg-muted/70 transition-colors"
    >
      <span className={`text-sm font-bold leading-none ${color}`}>{value}</span>
      <span className={`mt-0.5 ${color} opacity-60`}>{icon}</span>
    </Link>
  );
}

function GlobalChatInput({ onSent }: { onSent: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const r = await fetch("/api/global-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: t }),
      });
      if (r.ok) {
        setText("");
        onSent();
      }
    } finally {
      setSending(false);
    }
  }

  async function handleVoice(file: File) {
    setSending(true);
    try {
      const r = await fetch("/api/global-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "🎤 Голосовое сообщение" }),
      });
      if (!r.ok) return;
      const msg = await r.json();
      const fd = new FormData();
      fd.append("file", file);
      await fetch(`/api/global-chat/${msg.id}/attachments`, {
        method: "POST",
        body: fd,
      });
      onSent();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex items-center gap-2 bg-muted rounded-2xl px-3 py-1.5 mt-3">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleSend();
          }
        }}
        placeholder="Напишите сообщение..."
        className="flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground"
      />
      {text.trim() ? (
        <button
          onClick={() => void handleSend()}
          disabled={sending}
          className="w-7 h-7 rounded-lg bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center shrink-0 disabled:opacity-40"
        >
          <Send className="w-3.5 h-3.5 text-white" />
        </button>
      ) : (
        <VoiceRecorder
          onRecorded={(file) => void handleVoice(file)}
          disabled={sending}
        />
      )}
    </div>
  );
}
