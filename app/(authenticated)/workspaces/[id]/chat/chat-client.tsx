"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow, format } from "date-fns";
import { ru } from "date-fns/locale";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Plus,
  Send,
  CornerDownRight,
  X,
  Pencil,
  Trash2,
  Check,
  Forward,
  Paperclip,
  FileText,
  Download,
  Link2,
} from "lucide-react";
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

type MsgAttachment = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
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
  replyTo: { authorLogin: string; content: string } | null;
  reactions: Array<{ emoji: string; count: number; myReaction: boolean }>;
  attachments: MsgAttachment[];
  forwardedFrom: {
    originalAuthorLogin: string;
    originalChannelName: string | null;
  } | null;
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
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [forwardMsg, setForwardMsg] = useState<Msg | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkedTicketId, setLinkedTicketId] = useState<string | null>(null);
  const [linkedTaskId, setLinkedTaskId] = useState<string | null>(null);
  const [channelOrder, setChannelOrder] = useState<string[]>([]);
  const [dmOrder, setDmOrder] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /* thread panel removed — Telegram-style inline replies */
  const endRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

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

  // Split: pinned general, sortable channels, sortable DMs
  const generalCh = channels.filter((c) => c.type === "GENERAL");
  const regularCh = channels.filter(
    (c) => c.type !== "GENERAL" && c.type !== "DM",
  );
  const dmCh = channels.filter((c) => c.type === "DM");

  // Load saved order from localStorage
  const orderKey = `chat-order-${workspaceId}`;
  const dmOrderKey = `chat-dm-order-${workspaceId}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(orderKey);
      if (saved) setChannelOrder(JSON.parse(saved));
      const savedDm = localStorage.getItem(dmOrderKey);
      if (savedDm) setDmOrder(JSON.parse(savedDm));
    } catch {
      /* ignore */
    }
  }, [orderKey, dmOrderKey]);

  const sortedRegular = useMemo(() => {
    if (channelOrder.length === 0) return regularCh;
    const ordered: Channel[] = [];
    for (const id of channelOrder) {
      const ch = regularCh.find((c) => c.id === id);
      if (ch) ordered.push(ch);
    }
    // append new channels not in saved order
    for (const ch of regularCh) {
      if (!channelOrder.includes(ch.id)) ordered.push(ch);
    }
    return ordered;
  }, [regularCh, channelOrder]);

  const sortedDm = useMemo(() => {
    if (dmOrder.length === 0) return dmCh;
    const ordered: Channel[] = [];
    for (const id of dmOrder) {
      const ch = dmCh.find((c) => c.id === id);
      if (ch) ordered.push(ch);
    }
    for (const ch of dmCh) {
      if (!dmOrder.includes(ch.id)) ordered.push(ch);
    }
    return ordered;
  }, [dmCh, dmOrder]);

  const handleDragEndChannels = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const ids = sortedRegular.map((c) => c.id);
      const oldIdx = ids.indexOf(active.id as string);
      const newIdx = ids.indexOf(over.id as string);
      if (oldIdx === -1 || newIdx === -1) return;
      const newOrder = arrayMove(ids, oldIdx, newIdx);
      setChannelOrder(newOrder);
      localStorage.setItem(orderKey, JSON.stringify(newOrder));
    },
    [sortedRegular, orderKey],
  );

  const handleDragEndDm = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const ids = sortedDm.map((c) => c.id);
      const oldIdx = ids.indexOf(active.id as string);
      const newIdx = ids.indexOf(over.id as string);
      if (oldIdx === -1 || newIdx === -1) return;
      const newOrder = arrayMove(ids, oldIdx, newIdx);
      setDmOrder(newOrder);
      localStorage.setItem(dmOrderKey, JSON.stringify(newOrder));
    },
    [sortedDm, dmOrderKey],
  );

  const first = generalCh[0]?.id ?? channels[0]?.id ?? null;
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

  // Tasks & tickets for linking
  const { data: tasksD } = useQuery<{
    data: Array<{ id: string; title: string }>;
  }>({
    queryKey: ["ws-tasks-brief", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}/tasks?limit=100`).then((r) =>
        r.json(),
      ),
    staleTime: 30_000,
    enabled: linkPickerOpen,
  });
  const { data: ticketsD } = useQuery<{
    data: Array<{ id: string; number: number; title: string }>;
  }>({
    queryKey: ["ws-tickets-brief", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}/tickets?limit=100`).then((r) =>
        r.json(),
      ),
    staleTime: 30_000,
    enabled: linkPickerOpen,
  });

  const aCh = channels.find((c) => c.id === activeChannelId);

  /* ── actions ───────────────────────────────────────────────────────────── */

  const sendMut = useMutation({
    mutationFn: async (content: string) => {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            parentId: replyTo?.id,
            linkedTicketId: linkedTicketId ?? undefined,
            linkedTaskId: linkedTaskId ?? undefined,
          }),
        },
      );
      if (!r.ok)
        throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
      const msg = await r.json();
      // Upload pending files
      if (pendingFiles.length > 0) {
        for (const file of pendingFiles) {
          const fd = new FormData();
          fd.append("file", file);
          await fetch(
            `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${msg.id}/attachments`,
            { method: "POST", body: fd },
          );
        }
      }
      return msg;
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["chat-messages", activeChannelId],
      });
      void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
      setMsgText("");
      setReplyTo(null);
      setPendingFiles([]);
      setLinkedTicketId(null);
      setLinkedTaskId(null);
    },
    onError: toastApiError,
  });
  function send() {
    const t = msgText.trim();
    if ((t || pendingFiles.length > 0) && activeChannelId)
      sendMut.mutate(t || (pendingFiles.length > 0 ? "📎" : ""));
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

  async function saveEdit(msgId: string) {
    if (!editText.trim() || !activeChannelId) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${msgId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editText.trim() }),
      },
    );
    setEditingMsgId(null);
    setEditText("");
    void qc.invalidateQueries({ queryKey: ["chat-messages", activeChannelId] });
  }

  async function deleteMsg(msgId: string) {
    if (!activeChannelId) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${msgId}`,
      { method: "DELETE" },
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

  async function forwardToChannel(targetChannelId: string) {
    if (!forwardMsg || !activeChannelId) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${forwardMsg.id}/forward`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetChannelId }),
      },
    );
    toastSuccess("Сообщение переслано");
    setForwardMsg(null);
    void qc.invalidateQueries({ queryKey: ["chat-messages", targetChannelId] });
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
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Pinned: General */}
          {generalCh.length > 0 && (
            <div className="px-4 pt-2">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                📌 Закреплённые
              </div>
            </div>
          )}
          {generalCh.map((ch) => (
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

          {/* Sortable channels */}
          {sortedRegular.length > 0 && (
            <div className="px-4 pt-3">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                Каналы
              </div>
            </div>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEndChannels}
          >
            <SortableContext
              items={sortedRegular.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {sortedRegular.map((ch) => (
                <SortableChItem
                  key={ch.id}
                  ch={ch}
                  active={ch.id === activeChannelId}
                  onClick={() => {
                    setActiveChannelId(ch.id);
                    setShowInfo(false);
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Sortable DMs */}
          {sortedDm.length > 0 && (
            <div className="px-4 pt-3">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                Личные сообщения
              </div>
            </div>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEndDm}
          >
            <SortableContext
              items={sortedDm.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {sortedDm.map((ch) => (
                <SortableChItem
                  key={ch.id}
                  ch={ch}
                  active={ch.id === activeChannelId}
                  onClick={() => {
                    setActiveChannelId(ch.id);
                    setShowInfo(false);
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
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
                          <span
                            className="text-[10px] text-gray-400"
                            title={`Изменено ${format(new Date(m.editedAt), "dd.MM HH:mm", { locale: ru })}`}
                          >
                            изм.{" "}
                            {format(new Date(m.editedAt), "HH:mm", {
                              locale: ru,
                            })}
                          </span>
                        )}
                      </div>
                      <div
                        className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${isMe ? "bg-emerald-500 text-white rounded-br-md" : "bg-white border shadow-sm text-gray-700 rounded-bl-md"}`}
                      >
                        {/* forwarded header */}
                        {m.forwardedFrom && (
                          <div
                            className={`flex items-center gap-1 mb-1 text-[10px] ${isMe ? "text-white/60" : "text-gray-400"}`}
                          >
                            <Forward className="h-3 w-3" />
                            Переслано от {m.forwardedFrom.originalAuthorLogin}
                            {m.forwardedFrom.originalChannelName && (
                              <> из {m.forwardedFrom.originalChannelName}</>
                            )}
                          </div>
                        )}
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
                        {editingMsgId === m.id ? (
                          <div className="flex flex-col gap-1.5">
                            <textarea
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (
                                  e.key === "Enter" &&
                                  (e.metaKey || e.ctrlKey)
                                ) {
                                  e.preventDefault();
                                  void saveEdit(m.id);
                                }
                                if (e.key === "Escape") {
                                  setEditingMsgId(null);
                                }
                              }}
                              className="w-full bg-transparent outline-none resize-none text-sm min-h-[20px]"
                              autoFocus
                            />
                            <div className="flex gap-1 justify-end">
                              <button
                                onClick={() => setEditingMsgId(null)}
                                className={`text-[10px] px-2 py-0.5 rounded ${isMe ? "text-white/70 hover:text-white" : "text-gray-400 hover:text-gray-600"}`}
                              >
                                Отмена
                              </button>
                              <button
                                onClick={() => void saveEdit(m.id)}
                                className={`text-[10px] px-2 py-0.5 rounded font-medium ${isMe ? "bg-white/20 text-white" : "bg-emerald-100 text-emerald-700"}`}
                              >
                                <Check className="h-3 w-3 inline mr-0.5" />
                                Сохранить
                              </button>
                            </div>
                          </div>
                        ) : isMe ? (
                          m.content
                        ) : (
                          hl(m.content)
                        )}
                        {/* attachments */}
                        {m.attachments?.length > 0 && (
                          <div className="mt-1.5 space-y-1">
                            {m.attachments.map((att) => {
                              const isImage = att.mimeType.startsWith("image/");
                              return isImage ? (
                                <button
                                  key={att.id}
                                  type="button"
                                  onClick={() =>
                                    setLightboxUrl(
                                      `/api/chat-attachments/${att.id}`,
                                    )
                                  }
                                  className="block"
                                >
                                  <img
                                    src={`/api/chat-attachments/${att.id}`}
                                    alt={att.originalName}
                                    className="max-w-[120px] max-h-[90px] rounded-lg object-cover cursor-pointer hover:opacity-90 transition-opacity"
                                  />
                                </button>
                              ) : (
                                <a
                                  key={att.id}
                                  href={`/api/chat-attachments/${att.id}?download=1`}
                                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs ${isMe ? "bg-white/10 hover:bg-white/20 text-white" : "bg-gray-50 hover:bg-gray-100 text-gray-600"}`}
                                >
                                  <FileText className="h-4 w-4 shrink-0" />
                                  <span className="truncate flex-1">
                                    {att.originalName}
                                  </span>
                                  <span className="shrink-0 opacity-60">
                                    {fmtSize(att.size)}
                                  </span>
                                  <Download className="h-3 w-3 shrink-0" />
                                </a>
                              );
                            })}
                          </div>
                        )}
                        {/* linked items */}
                        {(m.linkedTicketId || m.linkedTaskId) && (
                          <div className={`mt-1.5 flex flex-wrap gap-1`}>
                            {m.linkedTicketId && (
                              <a
                                href={`/workspaces/${workspaceId}/tickets?id=${m.linkedTicketId}`}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${isMe ? "bg-white/15 text-white hover:bg-white/25" : "bg-blue-50 text-blue-600 hover:bg-blue-100"}`}
                              >
                                🎫 Тикет
                              </a>
                            )}
                            {m.linkedTaskId && (
                              <a
                                href={`/workspaces/${workspaceId}/crm?taskId=${m.linkedTaskId}`}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${isMe ? "bg-white/15 text-white hover:bg-white/25" : "bg-amber-50 text-amber-600 hover:bg-amber-100"}`}
                              >
                                📋 Задача
                              </a>
                            )}
                          </div>
                        )}
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
                        <button
                          onClick={() => setForwardMsg(m)}
                          className="p-1 rounded hover:bg-gray-200 text-gray-400"
                          title="Переслать"
                        >
                          <Forward className="h-3 w-3" />
                        </button>
                        {isMe && (
                          <>
                            <button
                              onClick={() => {
                                setEditingMsgId(m.id);
                                setEditText(m.content);
                              }}
                              className="p-1 rounded hover:bg-gray-200 text-gray-400"
                              title="Редактировать"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => {
                                if (confirm("Удалить сообщение?"))
                                  void deleteMsg(m.id);
                              }}
                              className="p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-500"
                              title="Удалить"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </>
                        )}
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

            {/* pending files preview */}
            {pendingFiles.length > 0 && (
              <div className="bg-white border-t px-5 py-2 flex gap-2 flex-wrap shrink-0">
                {pendingFiles.map((f, i) => {
                  const isImage = f.type.startsWith("image/");
                  return (
                    <div key={i} className="relative group/file">
                      {isImage ? (
                        <img
                          src={URL.createObjectURL(f)}
                          alt={f.name}
                          className="w-16 h-16 rounded-lg object-cover border"
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-lg border bg-gray-50 flex flex-col items-center justify-center text-[9px] text-gray-500 px-1">
                          <FileText className="h-5 w-5 mb-0.5 text-gray-400" />
                          <span className="truncate w-full text-center">
                            {f.name}
                          </span>
                        </div>
                      )}
                      <button
                        onClick={() =>
                          setPendingFiles((prev) =>
                            prev.filter((_, j) => j !== i),
                          )
                        }
                        className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center text-[10px] opacity-0 group-hover/file:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* linked item indicator */}
            {(linkedTicketId || linkedTaskId) && (
              <div className="bg-white border-t px-5 py-1.5 flex items-center gap-2 text-xs text-gray-500 shrink-0">
                <Link2 className="h-3 w-3 text-blue-500" />
                Привязано: {linkedTicketId ? "🎫 Тикет" : "📋 Задача"}
                <button
                  onClick={() => {
                    setLinkedTicketId(null);
                    setLinkedTaskId(null);
                  }}
                  className="ml-auto"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* input */}
            <div className="bg-white border-t px-5 py-3 shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.mp4,.mp3,.txt"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0)
                    setPendingFiles((prev) => [...prev, ...files]);
                  e.target.value = "";
                }}
              />
              <div className="flex items-end gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-9 h-9 rounded-lg hover:bg-gray-100 flex items-center justify-center shrink-0"
                  title="Прикрепить файл"
                >
                  <Paperclip className="w-5 h-5 text-gray-400" />
                </button>
                <button
                  onClick={() => setLinkPickerOpen(true)}
                  className={`w-9 h-9 rounded-lg hover:bg-gray-100 flex items-center justify-center shrink-0 ${linkedTicketId || linkedTaskId ? "text-blue-500" : ""}`}
                  title="Привязать к задаче/тикету"
                >
                  <Link2 className="w-5 h-5 text-gray-400" />
                </button>
                <div className="flex-1 bg-gray-100 rounded-2xl px-4 py-2.5 relative">
                  {/* @mention dropdown */}
                  {mentionQuery !== null &&
                    (() => {
                      const q = mentionQuery.toLowerCase();
                      const filtered = [{ login: "all" }, ...members].filter(
                        (m) => m.login.toLowerCase().includes(q),
                      );
                      if (filtered.length === 0) return null;
                      return (
                        <div className="absolute bottom-full left-0 right-0 mb-1 bg-white border rounded-xl shadow-lg max-h-48 overflow-y-auto z-20">
                          {filtered.slice(0, 8).map((m) => (
                            <button
                              key={m.login}
                              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-emerald-50 text-left transition-colors"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                const before = msgText.slice(
                                  0,
                                  msgText.lastIndexOf("@"),
                                );
                                setMsgText(before + "@" + m.login + " ");
                                setMentionQuery(null);
                              }}
                            >
                              <div
                                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${m.login === "all" ? "bg-amber-100 text-amber-700" : "bg-gray-200 text-gray-600"}`}
                              >
                                {m.login === "all"
                                  ? "📢"
                                  : m.login[0]?.toUpperCase()}
                              </div>
                              <span className="text-sm text-gray-700">
                                {m.login === "all"
                                  ? "@all — все участники"
                                  : m.login}
                              </span>
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  <textarea
                    value={msgText}
                    onChange={(e) => {
                      const val = e.target.value;
                      setMsgText(val);
                      // Detect @mention
                      const cursor = e.target.selectionStart;
                      const textBeforeCursor = val.slice(0, cursor);
                      const atMatch = textBeforeCursor.match(/@(\w*)$/);
                      if (atMatch) {
                        setMentionQuery(atMatch[1] ?? "");
                      } else {
                        setMentionQuery(null);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && mentionQuery !== null) {
                        setMentionQuery(null);
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        setMentionQuery(null);
                        send();
                      }
                    }}
                    onBlur={() => setTimeout(() => setMentionQuery(null), 200)}
                    placeholder="Напишите сообщение..."
                    rows={1}
                    className="w-full bg-transparent text-sm outline-none resize-none min-h-[20px] max-h-[120px] text-gray-700"
                  />
                </div>
                <button
                  className="w-9 h-9 rounded-xl bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center shrink-0 disabled:opacity-40"
                  disabled={
                    (!msgText.trim() && pendingFiles.length === 0) ||
                    sendMut.isPending
                  }
                  onClick={send}
                >
                  <Send className="w-4 h-4 text-white" />
                </button>
              </div>
              <div className="text-[10px] text-gray-400 mt-1 pl-[88px]">
                @упоминание · Enter — отправить · Shift+Enter — новая строка
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

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 text-white/80 hover:text-white"
          >
            <X className="h-8 w-8" />
          </button>
          <img
            src={lightboxUrl}
            alt=""
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Forward dialog */}
      <Dialog
        open={!!forwardMsg}
        onOpenChange={(v) => !v && setForwardMsg(null)}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Переслать сообщение</DialogTitle>
          </DialogHeader>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {channels
              .filter((c) => c.id !== activeChannelId)
              .map((c) => (
                <button
                  key={c.id}
                  onClick={() => void forwardToChannel(c.id)}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 flex items-center gap-2"
                >
                  <span className="text-sm">
                    {c.type === "DM" ? "👤" : c.type === "PRIVATE" ? "🔒" : "#"}
                  </span>
                  <span className="text-sm text-gray-700 truncate">
                    {c.name ?? "Личные"}
                  </span>
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Link picker dialog */}
      <Dialog open={linkPickerOpen} onOpenChange={setLinkPickerOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Привязать к задаче или тикету</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-80 overflow-y-auto">
            {(ticketsD?.data?.length ?? 0) > 0 && (
              <>
                <div className="text-[10px] font-bold text-gray-400 uppercase">
                  Тикеты
                </div>
                {ticketsD!.data.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setLinkedTicketId(t.id);
                      setLinkedTaskId(null);
                      setLinkPickerOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 text-sm ${linkedTicketId === t.id ? "bg-blue-50 border border-blue-200" : ""}`}
                  >
                    🎫 #{t.number} {t.title}
                  </button>
                ))}
              </>
            )}
            {(tasksD?.data?.length ?? 0) > 0 && (
              <>
                <div className="text-[10px] font-bold text-gray-400 uppercase mt-2">
                  Задачи
                </div>
                {tasksD!.data.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setLinkedTaskId(t.id);
                      setLinkedTicketId(null);
                      setLinkPickerOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 text-sm ${linkedTaskId === t.id ? "bg-amber-50 border border-amber-200" : ""}`}
                  >
                    📋 {t.title}
                  </button>
                ))}
              </>
            )}
            {!(tasksD?.data?.length ?? 0) && !(ticketsD?.data?.length ?? 0) && (
              <div className="text-sm text-gray-400 text-center py-4">
                Нет задач или тикетов
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

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

function SortableChItem({
  ch,
  active,
  onClick,
}: {
  ch: Channel;
  active: boolean;
  onClick: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ch.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ChItem ch={ch} active={active} onClick={onClick} />
    </div>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
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
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  const { data: memD } = useQuery<{
    members?: Array<{ id: string; login: string }>;
  }>({
    queryKey: ["workspace-members", wsId],
    queryFn: () => fetch(`/api/workspaces/${wsId}`).then((r) => r.json()),
    staleTime: 60_000,
    enabled: open,
  });
  const allMembers = memD?.members ?? [];

  const mut = useMutation({
    mutationFn: () =>
      fetch(`/api/workspaces/${wsId}/chat-channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: n.trim(),
          description: d.trim() || undefined,
          type: tp,
          memberIds: tp === "PRIVATE" ? selectedMembers : undefined,
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
      setSelectedMembers([]);
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
          <div className="text-[11px] text-gray-400">
            {tp === "PUBLIC"
              ? "Все участники пространства видят канал и могут писать"
              : "Только выбранные участники видят канал"}
          </div>
          {tp === "PRIVATE" && allMembers.length > 0 && (
            <div className="space-y-1 max-h-32 overflow-y-auto border rounded-lg p-2">
              <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">
                Участники
              </div>
              {allMembers.map((m) => (
                <label
                  key={m.id}
                  className="flex items-center gap-2 py-1 px-1 rounded hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={selectedMembers.includes(m.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedMembers((prev) => [...prev, m.id]);
                      } else {
                        setSelectedMembers((prev) =>
                          prev.filter((id) => id !== m.id),
                        );
                      }
                    }}
                  />
                  <div className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-[9px] font-bold text-gray-500">
                    {m.login[0]?.toUpperCase()}
                  </div>
                  <span className="text-xs text-gray-700">{m.login}</span>
                </label>
              ))}
            </div>
          )}
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
