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
  editedAt: string | null;
  createdAt: string;
  replyCount: number;
  replyTo: { authorLogin: string; content: string } | null;
  reactions: Array<{ emoji: string; count: number; myReaction: boolean }>;
};

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🔥"];

export function ChatClient({
  workspaceId,
  currentUserId,
  currentUserLogin: _login,
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
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  /* thread panel removed — Telegram-style inline replies */
  const endRef = useRef<HTMLDivElement>(null);

  /* ── data ──────────────────────────────────────────────────────────────── */

  const { data: chD } = useQuery<{ data: Channel[] }>({
    queryKey: ["chat-channels", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}/chat-channels`).then((r) =>
        r.json(),
      ),
    refetchInterval: 5000,
  });
  const channels = chD?.data ?? [];
  const first = channels[0]?.id ?? null;
  useEffect(() => {
    if (!activeChannelId && first) setActiveChannelId(first);
  }, [first, activeChannelId]);

  const { data: mD } = useQuery<{ data: Msg[] }>({
    queryKey: ["chat-messages", activeChannelId],
    queryFn: () =>
      fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages`,
      ).then((r) => r.json()),
    enabled: !!activeChannelId,
    refetchInterval: 2000,
  });
  const msgs = mD?.data ?? [];
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);
  useEffect(() => {
    if (activeChannelId)
      void fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/read`,
        { method: "POST" },
      );
  }, [activeChannelId, workspaceId, msgs.length]);

  const { data: sD } = useQuery<{
    data: Array<{
      id: string;
      content: string;
      authorLogin: string;
      channelId: string;
      channelName: string;
    }>;
  }>({
    queryKey: ["chat-search", workspaceId, searchQuery],
    queryFn: () =>
      fetch(
        `/api/workspaces/${workspaceId}/chat-channels/search?q=${encodeURIComponent(searchQuery)}`,
      ).then((r) => r.json()),
    enabled: searchQuery.length >= 2,
  });
  const searchResults = sD?.data ?? [];

  const { data: memD } = useQuery<{
    members?: Array<{ id: string; login: string }>;
  }>({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}`).then((r) => r.json()),
    staleTime: 60_000,
  });
  const members = memD?.members ?? [];

  const aCh = channels.find((c) => c.id === activeChannelId);

  /* ── actions ───────────────────────────────────────────────────────────── */

  const sendMut = useMutation({
    mutationFn: (content: string) =>
      fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, parentId: replyTo?.id }),
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
  function send() {
    const t = msgText.trim();
    if (t && activeChannelId) sendMut.mutate(t);
  }

  async function react(mid: string, emoji: string) {
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${mid}/reactions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      },
    );
    void qc.invalidateQueries({ queryKey: ["chat-messages", activeChannelId] });
  }

  async function startDM(uid: string) {
    const r = await fetch(`/api/workspaces/${workspaceId}/chat-channels/dm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId: uid }),
    });
    if (!r.ok) return;
    const dm = (await r.json()) as { id: string };
    void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
    setActiveChannelId(dm.id);
  }

  /* ── render ────────────────────────────────────────────────────────────── */

  return (
    <div className="flex" style={{ height: "100vh", marginTop: "-1px" }}>
      {/* ═══ LEFT ═══ */}
      <div className="w-[300px] bg-white border-r flex flex-col shrink-0 h-full">
        {/* header */}
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center text-white text-sm font-bold">
              💬
            </div>
            <span className="font-semibold text-sm text-gray-800">Чат</span>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center"
            title="Новый канал"
          >
            <Plus className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* search */}
        <div className="px-3 py-2 shrink-0">
          <div className="flex items-center gap-2 bg-gray-100 rounded-lg px-3 py-1.5">
            <svg
              className="w-4 h-4 text-gray-400 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск..."
              className="bg-transparent text-sm outline-none flex-1 text-gray-600"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")}>
                <X className="w-3 h-3 text-gray-400" />
              </button>
            )}
          </div>
        </div>

        {searchQuery.length >= 2 && searchResults.length > 0 && (
          <div className="px-3 pb-2 border-b shrink-0 max-h-40 overflow-y-auto">
            {searchResults.slice(0, 5).map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setActiveChannelId(r.channelId);
                  setSearchQuery("");
                }}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-xs"
              >
                <span className="font-medium text-gray-700">
                  {r.authorLogin}
                </span>{" "}
                <span className="text-gray-400">в {r.channelName}</span>
                <div className="text-gray-500 truncate">{r.content}</div>
              </button>
            ))}
          </div>
        )}

        {/* channels */}
        <div className="px-4 pt-2 shrink-0">
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
            Каналы
          </div>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {channels
            .filter((c) => c.type !== "DM")
            .map((ch) => (
              <ChItem
                key={ch.id}
                ch={ch}
                active={ch.id === activeChannelId}
                onClick={() => {
                  setActiveChannelId(ch.id);

                  setShowInfo(false);
                }}
              />
            ))}
          {channels.some((c) => c.type === "DM") && (
            <div className="px-4 pt-3">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                Личные сообщения
              </div>
            </div>
          )}
          {channels
            .filter((c) => c.type === "DM")
            .map((ch) => (
              <ChItem
                key={ch.id}
                ch={ch}
                active={ch.id === activeChannelId}
                onClick={() => {
                  setActiveChannelId(ch.id);

                  setShowInfo(false);
                }}
              />
            ))}
        </div>

        {/* members */}
        <div className="border-t px-3 py-2 shrink-0">
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-1 mb-1">
            Участники
          </div>
          <div className="space-y-0.5 max-h-[100px] overflow-y-auto">
            {members
              .filter((m) => m.id !== currentUserId)
              .map((m) => (
                <button
                  key={m.id}
                  onClick={() => void startDM(m.id)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 text-left"
                >
                  <div className="relative">
                    <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500">
                      {m.login[0]?.toUpperCase()}
                    </div>
                    <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-emerald-400 border border-white rounded-full" />
                  </div>
                  <span className="text-xs text-gray-700">{m.login}</span>
                </button>
              ))}
          </div>
        </div>
      </div>

      {/* ═══ CENTER ═══ */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-50 h-full">
        {aCh ? (
          <>
            {/* header */}
            <div className="bg-white border-b px-5 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-lg">
                  {aCh.type === "GENERAL"
                    ? "💬"
                    : aCh.type === "DM"
                      ? "👤"
                      : aCh.type === "PRIVATE"
                        ? "🔒"
                        : "#"}
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-800">
                    {aCh.name ?? "Личные сообщения"}
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {aCh.memberCount} участников
                  </div>
                </div>
              </div>
              <button
                className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center"
                onClick={() => {
                  setShowInfo(!showInfo);
                }}
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
              </button>
            </div>

            {/* messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
              {msgs.length === 0 && (
                <div className="flex items-center justify-center h-full text-sm text-gray-400">
                  Нет сообщений. Начните диалог!
                </div>
              )}
              {msgs.map((m) => {
                const isMe = m.authorId === currentUserId;
                return (
                  <div
                    key={m.id}
                    id={`msg-${m.id}`}
                    className={`group flex mb-3 transition-colors duration-700 rounded-lg ${isMe ? "justify-end" : "justify-start"} ${highlightMsgId === m.id ? "bg-emerald-100" : ""}`}
                  >
                    {!isMe && (
                      <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-600 shrink-0 mt-0.5 mr-2">
                        {m.authorLogin[0]?.toUpperCase()}
                      </div>
                    )}
                    <div
                      className={`max-w-[70%] flex flex-col ${isMe ? "items-end" : "items-start"}`}
                    >
                      <div
                        className={`flex items-center gap-2 mb-0.5 ${isMe ? "flex-row-reverse" : ""}`}
                      >
                        <span className="text-xs font-semibold text-gray-700">
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
                      <div
                        className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${isMe ? "bg-emerald-500 text-white rounded-br-md" : "bg-white border shadow-sm text-gray-700 rounded-bl-md"}`}
                      >
                        {m.replyTo && m.parentId && (
                          <button
                            type="button"
                            className={`mb-1.5 pl-2 border-l-2 text-xs text-left w-full ${isMe ? "border-white/50 hover:bg-white/10" : "border-emerald-400 hover:bg-emerald-50"} rounded transition-colors`}
                            onClick={() => {
                              const el = document.getElementById(
                                `msg-${m.parentId}`,
                              );
                              if (el) {
                                el.scrollIntoView({
                                  behavior: "smooth",
                                  block: "center",
                                });
                                setHighlightMsgId(m.parentId);
                                setTimeout(() => setHighlightMsgId(null), 1500);
                              }
                            }}
                          >
                            <div
                              className={`font-semibold ${isMe ? "text-white/80" : "text-emerald-600"}`}
                            >
                              {m.replyTo.authorLogin}
                            </div>
                            <div
                              className={`truncate ${isMe ? "text-white/60" : "text-gray-400"}`}
                            >
                              {m.replyTo.content}
                            </div>
                          </button>
                        )}
                        {isMe ? m.content : hl(m.content)}
                      </div>
                      {m.reactions.length > 0 && (
                        <div
                          className={`flex gap-1 mt-1 ${isMe ? "justify-end" : ""}`}
                        >
                          {m.reactions.map((r) => (
                            <button
                              key={r.emoji}
                              onClick={() => void react(m.id, r.emoji)}
                              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${r.myReaction ? "bg-emerald-50 border border-emerald-200" : "bg-gray-100 hover:bg-gray-200"}`}
                            >
                              {r.emoji}{" "}
                              <span className="text-gray-500">{r.count}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {/* replyCount removed — Telegram-style inline replies */}
                      <div
                        className={`opacity-0 group-hover:opacity-100 flex gap-0.5 mt-1 transition-opacity ${isMe ? "flex-row-reverse" : ""}`}
                      >
                        <button
                          onClick={() => setReplyTo(m)}
                          className="p-1 rounded hover:bg-gray-200 text-gray-400"
                          title="Ответить"
                        >
                          <CornerDownRight className="h-3 w-3" />
                        </button>
                        {QUICK_EMOJIS.map((e) => (
                          <button
                            key={e}
                            onClick={() => void react(m.id, e)}
                            className="p-1 rounded hover:bg-gray-200 text-xs"
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    </div>
                    {isMe && (
                      <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold text-white shrink-0 mt-0.5 ml-2">
                        {m.authorLogin[0]?.toUpperCase()}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>

            {/* reply indicator */}
            {replyTo && (
              <div className="bg-white border-t px-5 py-1.5 flex items-center gap-2 text-xs text-gray-500 shrink-0">
                <CornerDownRight className="h-3 w-3 text-emerald-500" />
                Ответ: <b>{replyTo.authorLogin}</b>:{" "}
                {replyTo.content.slice(0, 50)}
                <button onClick={() => setReplyTo(null)} className="ml-auto">
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* input */}
            <div className="bg-white border-t px-5 py-3 shrink-0">
              <div className="flex items-end gap-2">
                <button className="w-9 h-9 rounded-lg hover:bg-gray-100 flex items-center justify-center shrink-0">
                  <svg
                    className="w-5 h-5 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                    />
                  </svg>
                </button>
                <div className="flex-1 bg-gray-100 rounded-2xl px-4 py-2.5">
                  <textarea
                    value={msgText}
                    onChange={(e) => setMsgText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder="Напишите сообщение..."
                    rows={1}
                    className="w-full bg-transparent text-sm outline-none resize-none min-h-[20px] max-h-[120px] text-gray-700"
                  />
                </div>
                <button
                  className="w-9 h-9 rounded-xl bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center shrink-0 disabled:opacity-40"
                  disabled={!msgText.trim() || sendMut.isPending}
                  onClick={send}
                >
                  <Send className="w-4 h-4 text-white" />
                </button>
              </div>
              <div className="text-[10px] text-gray-400 mt-1 pl-12">
                @упоминание · Ctrl+Enter — отправить
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            Выберите канал
          </div>
        )}
      </div>

      {/* ═══ RIGHT: Info ═══ */}
      {showInfo && aCh && (
        <div className="w-[280px] bg-white border-l flex flex-col shrink-0 h-full">
          <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
            <span className="text-sm font-semibold">
              {aCh.type === "DM" ? "Личные сообщения" : aCh.name}
            </span>
            <button onClick={() => setShowInfo(false)}>
              <X className="h-4 w-4 text-gray-400" />
            </button>
          </div>
          {aCh.description && (
            <div className="px-4 py-3 border-b">
              <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">
                Описание
              </div>
              <div className="text-xs text-gray-600">{aCh.description}</div>
            </div>
          )}
          <div className="px-4 py-3 border-b shrink-0">
            <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">
              Тип
            </div>
            <div className="text-xs text-gray-600">
              {aCh.type === "GENERAL"
                ? "💬 Общий"
                : aCh.type === "PUBLIC"
                  ? "# Публичный"
                  : aCh.type === "PRIVATE"
                    ? "🔒 Приватный"
                    : "👤 ЛС"}
            </div>
          </div>
          <div className="px-4 py-3 flex-1 overflow-y-auto min-h-0">
            <div className="text-[10px] font-bold text-gray-400 uppercase mb-2">
              Участники · {aCh.memberCount}
            </div>
            <div className="space-y-2">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-2.5">
                  <div className="relative">
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-500">
                      {m.login[0]?.toUpperCase()}
                    </div>
                    <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-400 border-2 border-white rounded-full" />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-gray-700">
                      {m.login}
                    </div>
                    {m.id === currentUserId && (
                      <div className="text-[10px] text-gray-400">(вы)</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t px-4 py-3 shrink-0">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" defaultChecked className="rounded" />
              <span className="text-xs text-gray-600">
                Уведомления в Telegram
              </span>
            </label>
          </div>
        </div>
      )}

      <CCD open={createOpen} onClose={setCreateOpen} wsId={workspaceId} />
    </div>
  );
}

/* ── sub-components ────────────────────────────────────────────────────────── */

function ChItem({
  ch,
  active,
  onClick,
}: {
  ch: Channel;
  active: boolean;
  onClick: () => void;
}) {
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
      onClick={onClick}
      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${active ? "bg-emerald-50 border-l-[3px] border-emerald-500" : "hover:bg-gray-50 border-l-[3px] border-transparent"}`}
    >
      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-lg shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between">
          <span
            className={`text-sm truncate ${active ? "font-semibold" : "font-medium"} text-gray-800`}
          >
            {ch.name ?? "Личные"}
          </span>
          {ch.lastMessage && (
            <span className="text-[10px] text-gray-400 shrink-0 ml-1">
              {formatDistanceToNow(new Date(ch.lastMessage.createdAt), {
                locale: ru,
              })}
            </span>
          )}
        </div>
        {ch.lastMessage && (
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500 truncate">
              {ch.lastMessage.authorName}: {ch.lastMessage.content}
            </span>
            {ch.unreadCount > 0 && (
              <div className="bg-emerald-500 text-white text-[10px] rounded-full px-1.5 py-0.5 min-w-[18px] text-center font-medium shrink-0 ml-1">
                {ch.unreadCount}
              </div>
            )}
          </div>
        )}
      </div>
    </button>
  );
}

function hl(c: string) {
  return c.split(/(@\w+)/g).map((p, i) =>
    p.startsWith("@") ? (
      <span
        key={i}
        className="text-emerald-600 font-medium bg-emerald-50 rounded px-0.5"
      >
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function CCD({
  open,
  onClose,
  wsId,
}: {
  open: boolean;
  onClose: (v: boolean) => void;
  wsId: string;
}) {
  const qc = useQueryClient();
  const [n, setN] = useState("");
  const [d, setD] = useState("");
  const [tp, setTp] = useState<"PUBLIC" | "PRIVATE">("PUBLIC");
  const mut = useMutation({
    mutationFn: () =>
      fetch(`/api/workspaces/${wsId}/chat-channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: n.trim(),
          description: d.trim() || undefined,
          type: tp,
        }),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["chat-channels", wsId] });
      toastSuccess("Канал создан");
      setN("");
      setD("");
      onClose(false);
    },
    onError: toastApiError,
  });
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Новый канал</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <Input
            value={n}
            onChange={(e) => setN(e.target.value)}
            placeholder="Название канала"
          />
          <Input
            value={d}
            onChange={(e) => setD(e.target.value)}
            placeholder="Описание"
          />
          <div className="flex gap-2">
            <label
              className={`flex-1 p-2.5 border rounded-lg cursor-pointer text-center text-xs ${tp === "PUBLIC" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "text-gray-500"}`}
            >
              <input
                type="radio"
                className="hidden"
                checked={tp === "PUBLIC"}
                onChange={() => setTp("PUBLIC")}
              />
              # Публичный
            </label>
            <label
              className={`flex-1 p-2.5 border rounded-lg cursor-pointer text-center text-xs ${tp === "PRIVATE" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "text-gray-500"}`}
            >
              <input
                type="radio"
                className="hidden"
                checked={tp === "PRIVATE"}
                onChange={() => setTp("PRIVATE")}
              />
              🔒 Приватный
            </label>
          </div>
          <Button
            className="w-full"
            disabled={!n.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Создание..." : "Создать канал"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
