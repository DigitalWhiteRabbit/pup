"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow, format } from "date-fns";
import { ru } from "date-fns/locale";
import { Plus, Send, CornerDownRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastSuccess, toastApiError } from "@/lib/toast";

// ─── Types ──────────────────────────────────────────────────────────────────

type Channel = {
  id: string;
  type: string;
  name: string | null;
  description: string | null;
  memberCount: number;
  lastMessage: {
    content: string;
    authorName: string;
    createdAt: string;
  } | null;
  unreadCount: number;
};

type Msg = {
  id: string;
  authorId: string;
  authorLogin: string;
  content: string;
  parentId: string | null;
  linkedTicketId: string | null;
  linkedTaskId: string | null;
  editedAt: string | null;
  createdAt: string;
  replyCount: number;
  reactions: Array<{ emoji: string; count: number; myReaction: boolean }>;
};

// ─── Quick emoji picker ─────────────────────────────────────────────────────

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🔥", "👀", "🚀", "✅", "👎"];

// ─── Component ──────────────────────────────────────────────────────────────

export function ChatClient({
  workspaceId,
  currentUserId,
  currentUserLogin,
}: {
  workspaceId: string;
  currentUserId: string;
  currentUserLogin: string;
}) {
  const qc = useQueryClient();
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [msgText, setMsgText] = useState("");
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [threadMsgId, setThreadMsgId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ─── Channels ─────────────────────────────────────────────────────────────

  const { data: channelsData } = useQuery<{ data: Channel[] }>({
    queryKey: ["chat-channels", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/chat-channels`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    refetchInterval: 5000,
  });

  const channels = channelsData?.data ?? [];
  const firstChannelId = channels[0]?.id ?? null;

  // Auto-select first channel
  useEffect(() => {
    if (!activeChannelId && firstChannelId) {
      setActiveChannelId(firstChannelId);
    }
  }, [firstChannelId, activeChannelId]);

  // ─── Messages ─────────────────────────────────────────────────────────────

  const { data: msgsData } = useQuery<{ data: Msg[] }>({
    queryKey: ["chat-messages", activeChannelId],
    queryFn: async () => {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages`,
      );
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!activeChannelId,
    refetchInterval: 2000,
  });

  const messages = msgsData?.data ?? [];

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Mark read
  useEffect(() => {
    if (!activeChannelId) return;
    void fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/read`,
      { method: "POST" },
    );
  }, [activeChannelId, workspaceId, messages.length]);

  // ─── Send message ─────────────────────────────────────────────────────────

  const sendMut = useMutation({
    mutationFn: (content: string) =>
      fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            parentId: replyTo?.id,
          }),
        },
      ).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["chat-messages", activeChannelId],
      });
      void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
      setMsgText("");
      setReplyTo(null);
    },
    onError: toastApiError,
  });

  function handleSend() {
    const text = msgText.trim();
    if (!text || !activeChannelId) return;
    sendMut.mutate(text);
  }

  // ─── Reaction ─────────────────────────────────────────────────────────────

  async function handleReaction(messageId: string, emoji: string) {
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${messageId}/reactions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      },
    );
    void qc.invalidateQueries({ queryKey: ["chat-messages", activeChannelId] });
  }

  // ─── Thread ───────────────────────────────────────────────────────────────

  const { data: threadData } = useQuery<{ data: Msg[] }>({
    queryKey: ["chat-thread", threadMsgId],
    queryFn: async () => {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${threadMsgId}/thread`,
      );
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!threadMsgId,
    refetchInterval: 3000,
  });

  const threadReplies = threadData?.data ?? [];

  // Search
  const { data: searchData } = useQuery<{
    data: Array<{
      id: string;
      content: string;
      authorLogin: string;
      channelId: string;
      channelName: string;
    }>;
  }>({
    queryKey: ["chat-search", workspaceId, searchQuery],
    queryFn: async () => {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/chat-channels/search?q=${encodeURIComponent(searchQuery)}`,
      );
      if (!r.ok) return { data: [] };
      return r.json();
    },
    enabled: searchQuery.length >= 2,
  });
  const searchResults = searchData?.data ?? [];

  // Workspace members (for DM creation + info panel)
  const { data: membersData } = useQuery<{
    members?: Array<{ id: string; login: string }>;
  }>({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}`).then((r) => r.json()),
    staleTime: 60_000,
  });
  const members = membersData?.members ?? [];

  // Create DM
  async function startDM(targetUserId: string) {
    try {
      const r = await fetch(`/api/workspaces/${workspaceId}/chat-channels/dm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId }),
      });
      if (!r.ok) return;
      const dm = (await r.json()) as { id: string };
      void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
      setActiveChannelId(dm.id);
      setThreadMsgId(null);
    } catch {
      /* silent */
    }
  }

  const activeChannel = channels.find((c) => c.id === activeChannelId);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-3.5rem)] -m-6">
      {/* ═══ LEFT: Channel list ═══ */}
      <div className="w-[280px] bg-white border-r flex flex-col shrink-0">
        <div className="px-3 py-3 border-b flex items-center justify-between">
          <span className="font-semibold text-sm">Чат</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Search */}
        <div className="px-3 py-1.5">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск сообщений..."
            className="h-8 text-xs"
          />
        </div>

        {/* Search results */}
        {searchQuery.length >= 2 && searchResults.length > 0 && (
          <div className="px-3 pb-2 border-b">
            <div className="text-[10px] text-gray-400 mb-1">
              Найдено: {searchResults.length}
            </div>
            {searchResults.slice(0, 5).map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setActiveChannelId(r.channelId);
                  setSearchQuery("");
                }}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-xs"
              >
                <div className="text-gray-500">
                  <span className="font-medium text-gray-700">
                    {r.authorLogin}
                  </span>{" "}
                  в {r.channelName}
                </div>
                <div className="text-gray-600 truncate">{r.content}</div>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {channels.map((ch) => {
            const isActive = ch.id === activeChannelId;
            const icon =
              ch.type === "GENERAL"
                ? "💬"
                : ch.type === "DM"
                  ? "👤"
                  : ch.type === "PRIVATE"
                    ? "🔒"
                    : "#";
            return (
              <button
                key={ch.id}
                onClick={() => {
                  setActiveChannelId(ch.id);
                  setThreadMsgId(null);
                }}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors ${
                  isActive
                    ? "bg-emerald-50 border-l-2 border-emerald-500"
                    : "hover:bg-gray-50 border-l-2 border-transparent"
                }`}
              >
                <span className="text-lg w-8 text-center shrink-0">{icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between">
                    <span
                      className={`text-sm truncate ${isActive ? "font-semibold" : "font-medium"} text-gray-800`}
                    >
                      {ch.name ?? "Личные"}
                    </span>
                    {ch.lastMessage && (
                      <span className="text-[10px] text-gray-400 shrink-0">
                        {formatDistanceToNow(
                          new Date(ch.lastMessage.createdAt),
                          { locale: ru },
                        )}
                      </span>
                    )}
                  </div>
                  {ch.lastMessage && (
                    <div className="text-xs text-gray-500 truncate">
                      {ch.lastMessage.authorName}: {ch.lastMessage.content}
                    </div>
                  )}
                </div>
                {ch.unreadCount > 0 && (
                  <div className="bg-emerald-500 text-white text-[10px] rounded-full px-1.5 py-0.5 min-w-[18px] text-center font-medium">
                    {ch.unreadCount}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Members for DM */}
        <div className="border-t px-3 py-2">
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-1 mb-1">
            Участники
          </div>
          <div className="space-y-0.5 max-h-[150px] overflow-y-auto">
            {members
              .filter((m) => m.id !== currentUserId)
              .map((m) => (
                <button
                  key={m.id}
                  onClick={() => void startDM(m.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 text-left transition-colors"
                  title={`Написать ${m.login}`}
                >
                  <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500">
                    {m.login[0]?.toUpperCase()}
                  </div>
                  <span className="text-xs text-gray-700">{m.login}</span>
                </button>
              ))}
          </div>
        </div>
      </div>

      {/* ═══ CENTER: Messages ═══ */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-50">
        {activeChannel ? (
          <>
            {/* Header */}
            <div className="bg-white border-b px-4 py-2.5 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="text-sm font-semibold text-gray-800">
                  {activeChannel.name ?? `ЛС: ${currentUserLogin}`}
                </div>
                <div className="text-xs text-gray-400">
                  {activeChannel.type !== "DM" &&
                    `${activeChannel.memberCount} участников`}
                </div>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => {
                    setShowInfo(!showInfo);
                    setThreadMsgId(null);
                  }}
                  title="Инфо о канале"
                >
                  <svg
                    className="w-4 h-4 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </Button>
              </div>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {messages.map((m) => {
                const isMe = m.authorId === currentUserId;
                return (
                  <div
                    key={m.id}
                    className="group flex gap-2 mb-3 hover:bg-white/50 rounded-lg px-2 py-1 -mx-2 transition-colors"
                  >
                    <div
                      className={`w-8 h-8 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-xs font-bold ${isMe ? "bg-emerald-500 text-white" : "bg-gray-200 text-gray-600"}`}
                    >
                      {m.authorLogin[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-800">
                          {m.authorLogin}
                        </span>
                        <span className="text-[10px] text-gray-400">
                          {format(new Date(m.createdAt), "HH:mm", {
                            locale: ru,
                          })}
                        </span>
                        {m.editedAt && (
                          <span className="text-[10px] text-gray-400">
                            (ред.)
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">
                        {renderContent(m.content)}
                      </div>
                      {/* Reactions */}
                      {m.reactions.length > 0 && (
                        <div className="flex gap-1 mt-1">
                          {m.reactions.map((r) => (
                            <button
                              key={r.emoji}
                              onClick={() => void handleReaction(m.id, r.emoji)}
                              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
                                r.myReaction
                                  ? "bg-emerald-50 border border-emerald-200"
                                  : "bg-gray-100 hover:bg-gray-200"
                              }`}
                            >
                              {r.emoji}{" "}
                              <span className="text-gray-500">{r.count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {/* Thread link */}
                      {m.replyCount > 0 && (
                        <button
                          onClick={() => setThreadMsgId(m.id)}
                          className="flex items-center gap-1 mt-1 text-xs text-emerald-600 hover:text-emerald-700"
                        >
                          <CornerDownRight className="h-3 w-3" />
                          {m.replyCount}{" "}
                          {m.replyCount === 1 ? "ответ" : "ответов"}
                        </button>
                      )}
                      {/* Actions (hover) */}
                      <div className="opacity-0 group-hover:opacity-100 flex gap-0.5 mt-1 transition-opacity">
                        <button
                          onClick={() => setReplyTo(m)}
                          className="p-1 rounded hover:bg-gray-200 text-gray-400"
                          title="Ответить"
                        >
                          <CornerDownRight className="h-3 w-3" />
                        </button>
                        {QUICK_EMOJIS.slice(0, 4).map((e) => (
                          <button
                            key={e}
                            onClick={() => void handleReaction(m.id, e)}
                            className="p-1 rounded hover:bg-gray-200 text-xs"
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply indicator */}
            {replyTo && (
              <div className="bg-white border-t px-4 py-1.5 flex items-center gap-2 text-xs text-gray-500">
                <CornerDownRight className="h-3 w-3 text-emerald-500" />
                Ответ на:{" "}
                <span className="font-medium">{replyTo.authorLogin}</span>:{" "}
                {replyTo.content.slice(0, 50)}
                <button onClick={() => setReplyTo(null)} className="ml-auto">
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* Input */}
            <div className="bg-white border-t px-4 py-2.5 shrink-0">
              <div className="flex items-end gap-2">
                <textarea
                  value={msgText}
                  onChange={(e) => setMsgText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Напишите сообщение... (@упоминание)"
                  rows={1}
                  className="flex-1 resize-none rounded-xl border border-gray-200 px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
                />
                <Button
                  size="icon"
                  className="h-9 w-9 rounded-xl bg-emerald-500 hover:bg-emerald-600 shrink-0"
                  disabled={!msgText.trim() || sendMut.isPending}
                  onClick={handleSend}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            Выберите канал
          </div>
        )}
      </div>

      {/* ═══ RIGHT: Thread panel ═══ */}
      {threadMsgId && (
        <div className="w-[300px] bg-white border-l flex flex-col shrink-0">
          <div className="px-4 py-2.5 border-b flex items-center justify-between">
            <span className="text-sm font-semibold">Тред</span>
            <button onClick={() => setThreadMsgId(null)}>
              <X className="h-4 w-4 text-gray-400" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {threadReplies.map((m) => (
              <div key={m.id} className="flex gap-2 mb-3">
                <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500 shrink-0 mt-0.5">
                  {m.authorLogin[0]?.toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold">
                      {m.authorLogin}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {format(new Date(m.createdAt), "HH:mm")}
                    </span>
                  </div>
                  <div className="text-xs text-gray-700 whitespace-pre-wrap">
                    {renderContent(m.content)}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Thread reply input */}
          <div className="border-t px-3 py-2">
            <ThreadReplyInput
              workspaceId={workspaceId}
              channelId={activeChannelId!}
              parentId={threadMsgId}
              onSent={() => {
                void qc.invalidateQueries({
                  queryKey: ["chat-thread", threadMsgId],
                });
                void qc.invalidateQueries({
                  queryKey: ["chat-messages", activeChannelId],
                });
              }}
            />
          </div>
        </div>
      )}

      {/* ═══ RIGHT: Info panel ═══ */}
      {showInfo && activeChannel && !threadMsgId && (
        <div className="w-[280px] bg-white border-l flex flex-col shrink-0">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <span className="text-sm font-semibold">
              {activeChannel.type === "DM"
                ? "Личные сообщения"
                : activeChannel.name}
            </span>
            <button onClick={() => setShowInfo(false)}>
              <X className="h-4 w-4 text-gray-400" />
            </button>
          </div>

          {activeChannel.description && (
            <div className="px-4 py-2 border-b">
              <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">
                Описание
              </div>
              <div className="text-xs text-gray-600">
                {activeChannel.description}
              </div>
            </div>
          )}

          <div className="px-4 py-2 border-b">
            <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">
              Тип
            </div>
            <div className="text-xs text-gray-600">
              {activeChannel.type === "GENERAL"
                ? "💬 Общий (все участники)"
                : activeChannel.type === "PUBLIC"
                  ? "# Публичный"
                  : activeChannel.type === "PRIVATE"
                    ? "🔒 Приватный"
                    : "👤 Личные сообщения"}
            </div>
          </div>

          <div className="px-4 py-2 flex-1 overflow-y-auto">
            <div className="text-[10px] font-bold text-gray-400 uppercase mb-2">
              Участники · {activeChannel.memberCount}
            </div>
            <div className="space-y-1.5">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500">
                    {m.login[0]?.toUpperCase()}
                  </div>
                  <span className="text-xs text-gray-700">{m.login}</span>
                  {m.id === currentUserId && (
                    <span className="text-[10px] text-gray-400">(вы)</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Create channel dialog */}
      <CreateChannelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderContent(content: string) {
  // Highlight @mentions
  return content.split(/(@\w+)/g).map((part, i) =>
    part.startsWith("@") ? (
      <span
        key={i}
        className="text-emerald-600 font-medium bg-emerald-50 rounded px-0.5"
      >
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function ThreadReplyInput({
  workspaceId,
  channelId,
  parentId,
  onSent,
}: {
  workspaceId: string;
  channelId: string;
  parentId: string;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${channelId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text.trim(), parentId }),
        },
      );
      setText("");
      onSent();
    } catch {
      /* silent */
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex gap-1.5">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Ответить в тред..."
        className="flex-1 rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
      />
      <Button
        size="icon"
        className="h-7 w-7 rounded-lg bg-emerald-500 hover:bg-emerald-600 shrink-0"
        disabled={!text.trim() || sending}
        onClick={() => void send()}
      >
        <Send className="h-3 w-3" />
      </Button>
    </div>
  );
}

function CreateChannelDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [type, setType] = useState<"PUBLIC" | "PRIVATE">("PUBLIC");

  const mut = useMutation({
    mutationFn: () =>
      fetch(`/api/workspaces/${workspaceId}/chat-channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: desc.trim() || undefined,
          type,
        }),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
      toastSuccess("Канал создан");
      setName("");
      setDesc("");
      onOpenChange(false);
    },
    onError: toastApiError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Новый канал</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div>
            <label className="text-sm font-medium mb-1 block">Название</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Разработка"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Описание</label>
            <Input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Обсуждение разработки"
            />
          </div>
          <div className="flex gap-2">
            <label
              className={`flex-1 p-2 border rounded-lg cursor-pointer text-center text-xs ${type === "PUBLIC" ? "border-emerald-500 bg-emerald-50" : ""}`}
            >
              <input
                type="radio"
                className="hidden"
                checked={type === "PUBLIC"}
                onChange={() => setType("PUBLIC")}
              />
              # Публичный
            </label>
            <label
              className={`flex-1 p-2 border rounded-lg cursor-pointer text-center text-xs ${type === "PRIVATE" ? "border-emerald-500 bg-emerald-50" : ""}`}
            >
              <input
                type="radio"
                className="hidden"
                checked={type === "PRIVATE"}
                onChange={() => setType("PRIVATE")}
              />
              🔒 Приватный
            </label>
          </div>
          <Button
            className="w-full"
            disabled={!name.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Создание..." : "Создать канал"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
