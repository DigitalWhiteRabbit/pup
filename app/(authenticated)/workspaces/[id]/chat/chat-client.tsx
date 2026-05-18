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
  Pin,
  Bookmark,
  BookmarkCheck,
  BellOff,
  Bell,
  UserPlus,
  UserMinus,
  CheckCheck,
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
import { MessageContent } from "@/components/chat/message-content";
import { LinkPreview, extractUrl } from "@/components/chat/link-preview";
import { VoiceRecorder, VoicePlayer } from "@/components/chat/voice-recorder";

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
  muted: boolean;
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
  readByCount: number;
  pinnedAt: string | null;
  bookmarked?: boolean;
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
  const [activeChannelId, setActiveChannelId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("channel");
  });
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
  const [dragOver, setDragOver] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [manageMembersOpen, setManageMembersOpen] = useState(false);
  const [mobileShowChat, setMobileShowChat] = useState(false);
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
  const prevMsgCountRef = useRef(0);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only auto-scroll if new messages arrived AND user is near bottom
    if (msgs.length > prevMsgCountRef.current) {
      const container = messagesContainerRef.current;
      if (container) {
        const isNearBottom =
          container.scrollHeight -
            container.scrollTop -
            container.clientHeight <
          150;
        if (isNearBottom) {
          endRef.current?.scrollIntoView({ behavior: "smooth" });
        }
      } else {
        endRef.current?.scrollIntoView({ behavior: "smooth" });
      }
    }
    prevMsgCountRef.current = msgs.length;
  }, [msgs.length]);
  const prevMsgCountForRead = useRef(0);
  useEffect(() => {
    // Only mark read when channel changes or new messages arrive
    if (activeChannelId && msgs.length > prevMsgCountForRead.current) {
      void fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/read`,
        { method: "POST" },
      );
    }
    prevMsgCountForRead.current = msgs.length;
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

  // Typing indicator
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendTyping = useCallback(() => {
    if (!activeChannelId) return;
    void fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/typing`,
      { method: "POST" },
    );
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      typingTimerRef.current = null;
    }, 3000);
  }, [activeChannelId, workspaceId]);

  const { data: typingD } = useQuery<{ data: Array<{ login: string }> }>({
    queryKey: ["chat-typing", activeChannelId],
    queryFn: () =>
      fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/typing`,
      ).then((r) => r.json()),
    enabled: !!activeChannelId,
    refetchInterval: 2000,
  });
  const typingUsers = typingD?.data ?? [];

  // Pinned messages
  const { data: pinnedD } = useQuery<{ data: Msg[] }>({
    queryKey: ["chat-pinned", activeChannelId],
    queryFn: () =>
      fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/pinned`,
      ).then((r) => r.json()),
    enabled: !!activeChannelId,
    staleTime: 10_000,
  });
  const pinnedMsgs = pinnedD?.data ?? [];

  // Bookmarks
  const { data: bookmarksD } = useQuery<{
    data: Array<{
      id: string;
      messageId: string;
      message: {
        content: string;
        authorLogin: string;
        channelName: string;
        channelId: string;
      };
    }>;
  }>({
    queryKey: ["chat-bookmarks"],
    queryFn: () => fetch("/api/bookmarks").then((r) => r.json()),
    enabled: bookmarksOpen,
  });

  // Online users
  const { data: onlineD } = useQuery<{ data: string[] }>({
    queryKey: ["online-users"],
    queryFn: () =>
      fetch("/api/users/online")
        .then((r) => r.json())
        .then((d) => ({
          data: d.users?.map((u: { login: string }) => u.login) ?? [],
        })),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const onlineLogins = useMemo(
    () => new Set(onlineD?.data ?? []),
    [onlineD?.data],
  );

  const aCh = channels.find((c) => c.id === activeChannelId);

  /* ── actions ───────────────────────────────────────────────────────────── */

  const sendMut = useMutation({
    mutationFn: async (args: {
      content: string;
      parentId?: string;
      linkedTicketId?: string;
      linkedTaskId?: string;
      files: File[];
      channelId: string;
    }) => {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/chat-channels/${args.channelId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: args.content,
            parentId: args.parentId,
            linkedTicketId: args.linkedTicketId,
            linkedTaskId: args.linkedTaskId,
          }),
        },
      );
      if (!r.ok)
        throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
      const msg = await r.json();
      // Upload pending files
      const failedFiles: string[] = [];
      for (const file of args.files) {
        const fd = new FormData();
        fd.append("file", file);
        const ur = await fetch(
          `/api/workspaces/${workspaceId}/chat-channels/${args.channelId}/messages/${msg.id}/attachments`,
          { method: "POST", body: fd },
        );
        if (!ur.ok) failedFiles.push(file.name);
      }
      if (failedFiles.length > 0)
        throw new Error(`Не удалось загрузить: ${failedFiles.join(", ")}`);
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
      sendMut.mutate({
        content: t || (pendingFiles.length > 0 ? "📎" : ""),
        parentId: replyTo?.id,
        linkedTicketId: linkedTicketId ?? undefined,
        linkedTaskId: linkedTaskId ?? undefined,
        files: pendingFiles,
        channelId: activeChannelId,
      });
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

  async function togglePin(msgId: string) {
    if (!activeChannelId) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${msgId}/pin`,
      { method: "POST" },
    );
    void qc.invalidateQueries({ queryKey: ["chat-pinned", activeChannelId] });
    void qc.invalidateQueries({ queryKey: ["chat-messages", activeChannelId] });
  }

  async function toggleBookmark(msgId: string) {
    if (!activeChannelId) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/messages/${msgId}/bookmark`,
      { method: "POST" },
    );
    void qc.invalidateQueries({ queryKey: ["chat-messages", activeChannelId] });
    void qc.invalidateQueries({ queryKey: ["chat-bookmarks"] });
  }

  async function toggleMute() {
    if (!activeChannelId) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/mute`,
      { method: "POST" },
    );
    void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
    toastSuccess(aCh?.muted ? "Уведомления включены" : "Канал отключён");
  }

  async function addMember(userId: string) {
    if (!activeChannelId) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
    );
    void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
    toastSuccess("Участник добавлен");
  }

  async function removeMember(userId: string) {
    if (!activeChannelId) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}/members`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      },
    );
    void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
    toastSuccess("Участник удалён");
  }

  async function deleteChannel() {
    if (!activeChannelId || !confirm("Удалить канал?")) return;
    await fetch(
      `/api/workspaces/${workspaceId}/chat-channels/${activeChannelId}`,
      { method: "DELETE" },
    );
    setActiveChannelId(null);
    void qc.invalidateQueries({ queryKey: ["chat-channels", workspaceId] });
    toastSuccess("Канал удалён");
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) setPendingFiles((prev) => [...prev, ...files]);
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
    <div className="flex h-[100dvh] md:h-screen" style={{ marginTop: "-1px" }}>
      {/* ═══ LEFT ═══ */}
      <div
        className={`w-full md:w-[300px] bg-card border-r flex flex-col shrink-0 h-full ${mobileShowChat ? "hidden md:flex" : "flex"}`}
      >
        {/* header */}
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center text-white text-sm font-bold">
              💬
            </div>
            <span className="font-semibold text-sm text-foreground">Чат</span>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center"
            title="Новый канал"
          >
            <Plus className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* search */}
        <div className="px-3 py-2 shrink-0">
          <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-1.5">
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
              className="bg-transparent text-sm outline-none flex-1 text-foreground"
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
                className="w-full text-left px-2 py-1.5 rounded hover:bg-muted/50 text-xs"
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
                setMobileShowChat(true);
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
                  className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/50 text-left"
                >
                  <div className="relative">
                    <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                      {m.login[0]?.toUpperCase()}
                    </div>
                    <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-emerald-400 border border-white rounded-full" />
                  </div>
                  <span className="text-xs text-foreground">{m.login}</span>
                </button>
              ))}
          </div>
        </div>
      </div>

      {/* ═══ CENTER ═══ */}
      <div
        className={`flex-1 flex flex-col min-w-0 bg-muted/30 h-full ${mobileShowChat ? "flex" : "hidden md:flex"}`}
      >
        {aCh ? (
          <>
            {/* header */}
            <div className="bg-card border-b px-3 md:px-5 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 md:gap-3">
                <button
                  onClick={() => setMobileShowChat(false)}
                  className="md:hidden p-1 rounded-lg hover:bg-muted text-muted-foreground"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
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
                  <div className="text-sm font-semibold text-foreground">
                    {aCh.name ?? "Личные сообщения"}
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {aCh.memberCount} участников
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => void toggleMute()}
                  className={`w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center ${aCh?.muted ? "text-red-400" : "text-gray-400"}`}
                  title={
                    aCh?.muted
                      ? "Включить уведомления"
                      : "Отключить уведомления"
                  }
                >
                  {aCh?.muted ? (
                    <BellOff className="w-4 h-4" />
                  ) : (
                    <Bell className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={() => setBookmarksOpen(true)}
                  className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center text-gray-400"
                  title="Избранное"
                >
                  <Bookmark className="w-4 h-4" />
                </button>
                <button
                  className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center text-gray-400"
                  onClick={() => setShowInfo(!showInfo)}
                  title="Информация"
                >
                  <svg
                    className="w-4 h-4"
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
            </div>

            {/* pinned messages banner */}
            {pinnedMsgs.length > 0 && (
              <div className="bg-amber-50 dark:bg-amber-900/20 border-b px-3 md:px-5 py-2 shrink-0 flex items-center gap-2">
                <Pin className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                <span className="text-xs text-amber-700 truncate flex-1">
                  <b>{pinnedMsgs[0]?.authorLogin}</b>:{" "}
                  {pinnedMsgs[0]?.content.slice(0, 60)}
                  {pinnedMsgs.length > 1 && ` (+${pinnedMsgs.length - 1})`}
                </span>
              </div>
            )}

            {/* messages + drag & drop zone */}
            <div
              ref={messagesContainerRef}
              className={`flex-1 overflow-y-auto px-3 md:px-5 py-4 min-h-0 relative ${dragOver ? "bg-emerald-50" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
            >
              {dragOver && (
                <div className="absolute inset-0 flex items-center justify-center bg-emerald-50/80 dark:bg-emerald-900/30 z-10 border-2 border-dashed border-emerald-400 rounded-lg">
                  <div className="text-emerald-600 font-medium text-sm">
                    Перетащите файлы сюда
                  </div>
                </div>
              )}
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
                      <div className="relative shrink-0 mt-0.5 mr-2">
                        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                          {m.authorLogin[0]?.toUpperCase()}
                        </div>
                        {onlineLogins.has(m.authorLogin) && (
                          <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-400 border-2 border-gray-50 rounded-full" />
                        )}
                      </div>
                    )}
                    <div
                      className={`max-w-[85%] md:max-w-[70%] flex flex-col ${isMe ? "items-end" : "items-start"}`}
                    >
                      <div
                        className={`flex items-center gap-2 mb-0.5 ${isMe ? "flex-row-reverse" : ""}`}
                      >
                        <span className="text-xs font-semibold text-foreground">
                          {m.authorLogin}
                        </span>
                        <span className="text-[10px] text-gray-400">
                          {format(new Date(m.createdAt), "HH:mm", {
                            locale: ru,
                          })}
                        </span>
                        {isMe && (
                          <span
                            className={`text-[10px] ${m.readByCount > 0 ? "text-blue-400" : "text-gray-300"}`}
                            title={
                              m.readByCount > 0
                                ? `Прочитано: ${m.readByCount}`
                                : "Доставлено"
                            }
                          >
                            {m.readByCount > 0 ? (
                              <CheckCheck className="h-3 w-3 inline" />
                            ) : (
                              <Check className="h-3 w-3 inline" />
                            )}
                          </span>
                        )}
                        {m.pinnedAt && (
                          <Pin className="h-3 w-3 text-amber-500 inline" />
                        )}
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
                        className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${isMe ? "bg-emerald-500 text-white rounded-br-md" : "bg-card border shadow-sm text-card-foreground rounded-bl-md"}`}
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
                        ) : (
                          <MessageContent content={m.content} isMe={isMe} />
                        )}
                        {/* attachments */}
                        {m.attachments?.length > 0 && (
                          <div className="mt-1.5 space-y-1">
                            {m.attachments.map((att) => {
                              const isImage = att.mimeType.startsWith("image/");
                              const isAudio = att.mimeType.startsWith("audio/");
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
                              ) : isAudio ? (
                                <div key={att.id}>
                                  <VoicePlayer
                                    src={`/api/chat-attachments/${att.id}`}
                                    isMe={isMe}
                                  />
                                </div>
                              ) : (
                                <a
                                  key={att.id}
                                  href={`/api/chat-attachments/${att.id}?download=1`}
                                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs ${isMe ? "bg-white/10 hover:bg-white/20 text-white" : "bg-gray-50 hover:bg-muted text-gray-600"}`}
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
                        {/* link preview */}
                        {(() => {
                          const url = extractUrl(m.content);
                          return url ? (
                            <LinkPreview url={url} isMe={isMe} />
                          ) : null;
                        })()}
                      </div>
                      {m.reactions.length > 0 && (
                        <div
                          className={`flex gap-1 mt-1 ${isMe ? "justify-end" : ""}`}
                        >
                          {m.reactions.map((r) => (
                            <button
                              key={r.emoji}
                              onClick={() => void react(m.id, r.emoji)}
                              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${r.myReaction ? "bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700" : "bg-muted hover:bg-muted/80"}`}
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
                          className="p-1 rounded hover:bg-muted text-muted-foreground"
                          title="Ответить"
                        >
                          <CornerDownRight className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => setForwardMsg(m)}
                          className="p-1 rounded hover:bg-muted text-muted-foreground"
                          title="Переслать"
                        >
                          <Forward className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => void togglePin(m.id)}
                          className={`p-1 rounded hover:bg-gray-200 ${m.pinnedAt ? "text-amber-500" : "text-gray-400"}`}
                          title={m.pinnedAt ? "Открепить" : "Закрепить"}
                        >
                          <Pin className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => void toggleBookmark(m.id)}
                          className={`p-1 rounded hover:bg-gray-200 ${m.bookmarked ? "text-blue-500" : "text-gray-400"}`}
                          title={
                            m.bookmarked
                              ? "Убрать из избранного"
                              : "В избранное"
                          }
                        >
                          {m.bookmarked ? (
                            <BookmarkCheck className="h-3 w-3" />
                          ) : (
                            <Bookmark className="h-3 w-3" />
                          )}
                        </button>
                        {isMe && (
                          <>
                            <button
                              onClick={() => {
                                setEditingMsgId(m.id);
                                setEditText(m.content);
                              }}
                              className="p-1 rounded hover:bg-muted text-muted-foreground"
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

            {/* typing indicator */}
            {typingUsers.length > 0 && (
              <div className="bg-white border-t px-3 md:px-5 py-1 shrink-0">
                <span className="text-xs text-gray-400 italic">
                  {typingUsers.map((u) => u.login).join(", ")} печатает...
                </span>
              </div>
            )}

            {/* reply indicator */}
            {replyTo && (
              <div className="bg-card border-t px-3 md:px-5 py-1.5 flex items-center gap-2 text-xs text-gray-500 shrink-0">
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
              <div className="bg-card border-t px-3 md:px-5 py-2 flex gap-2 flex-wrap shrink-0">
                {pendingFiles.map((f, i) => {
                  const isImage = f.type.startsWith("image/");
                  return (
                    <div key={i} className="relative group/file">
                      {isImage ? (
                        <FilePreviewImg file={f} />
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
              <div className="bg-card border-t px-3 md:px-5 py-1.5 flex items-center gap-2 text-xs text-gray-500 shrink-0">
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
            <div className="bg-card border-t px-3 md:px-5 py-3 shrink-0">
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
                  className="w-9 h-9 rounded-lg hover:bg-muted flex items-center justify-center shrink-0"
                  title="Прикрепить файл"
                >
                  <Paperclip className="w-5 h-5 text-gray-400" />
                </button>
                <button
                  onClick={() => setLinkPickerOpen(true)}
                  className={`w-9 h-9 rounded-lg hover:bg-muted flex items-center justify-center shrink-0 ${linkedTicketId || linkedTaskId ? "text-blue-500" : ""}`}
                  title="Привязать к задаче/тикету"
                >
                  <Link2 className="w-5 h-5 text-gray-400" />
                </button>
                <div className="flex-1 bg-muted rounded-2xl px-4 py-2.5 relative">
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
                              <span className="text-sm text-foreground">
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
                      if (val.trim() && !typingTimerRef.current) sendTyping();
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
                    className="w-full bg-transparent text-sm outline-none resize-none min-h-[20px] max-h-[120px] text-foreground"
                  />
                </div>
                {msgText.trim() || pendingFiles.length > 0 ? (
                  <button
                    className="w-9 h-9 rounded-xl bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center shrink-0 disabled:opacity-40"
                    disabled={sendMut.isPending}
                    onClick={send}
                  >
                    <Send className="w-4 h-4 text-white" />
                  </button>
                ) : (
                  <VoiceRecorder
                    onRecorded={(file) => {
                      if (!activeChannelId) return;
                      sendMut.mutate({
                        content: "🎤 Голосовое сообщение",
                        files: [file],
                        channelId: activeChannelId,
                      });
                    }}
                    disabled={sendMut.isPending}
                  />
                )}
              </div>
              <div className="text-[10px] text-gray-400 mt-1 pl-[88px] hidden md:block">
                @упоминание · Enter — отправить · Shift+Enter — новая строка ·
                🎤 голосовое
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
        <div className="fixed inset-0 z-40 bg-card md:static md:inset-auto md:z-auto md:w-[280px] md:border-l flex flex-col shrink-0 h-full">
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
              <div className="text-xs text-muted-foreground">
                {aCh.description}
              </div>
            </div>
          )}
          <div className="px-4 py-3 border-b shrink-0">
            <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">
              Тип
            </div>
            <div className="text-xs text-muted-foreground">
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
                    <div className="text-xs font-medium text-foreground">
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
          <div className="border-t px-4 py-2 shrink-0 space-y-1">
            {aCh.type !== "GENERAL" && aCh.type !== "DM" && (
              <button
                onClick={() => setManageMembersOpen(true)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-muted/50"
              >
                <UserPlus className="h-3.5 w-3.5" /> Управление участниками
              </button>
            )}
            {aCh.type !== "GENERAL" && aCh.type !== "DM" && (
              <button
                onClick={() => void deleteChannel()}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-red-500 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> Удалить канал
              </button>
            )}
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
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-muted/50 flex items-center gap-2"
                >
                  <span className="text-sm">
                    {c.type === "DM" ? "👤" : c.type === "PRIVATE" ? "🔒" : "#"}
                  </span>
                  <span className="text-sm text-foreground truncate">
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
                    className={`w-full text-left px-3 py-2 rounded-lg hover:bg-muted/50 text-sm ${linkedTicketId === t.id ? "bg-blue-50 border border-blue-200" : ""}`}
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
                    className={`w-full text-left px-3 py-2 rounded-lg hover:bg-muted/50 text-sm ${linkedTaskId === t.id ? "bg-amber-50 border border-amber-200" : ""}`}
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

      {/* Bookmarks dialog */}
      <Dialog open={bookmarksOpen} onOpenChange={setBookmarksOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Избранные сообщения</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {(bookmarksD?.data?.length ?? 0) === 0 && (
              <div className="text-sm text-gray-400 text-center py-4">
                Нет сохранённых сообщений
              </div>
            )}
            {bookmarksD?.data?.map((b) => (
              <button
                key={b.id}
                onClick={() => {
                  setActiveChannelId(b.message.channelId);
                  setBookmarksOpen(false);
                }}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-muted/50"
              >
                <div className="text-xs font-medium text-foreground">
                  {b.message.authorLogin}{" "}
                  <span className="text-gray-400 font-normal">
                    в {b.message.channelName}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {b.message.content}
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Manage members dialog */}
      <Dialog open={manageMembersOpen} onOpenChange={setManageMembersOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Участники канала</DialogTitle>
          </DialogHeader>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-muted/50"
              >
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                    {m.login[0]?.toUpperCase()}
                  </div>
                  <span className="text-sm text-foreground">{m.login}</span>
                </div>
                {m.id !== currentUserId && (
                  <button
                    onClick={() => void removeMember(m.id)}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="border-t pt-2 mt-2">
            <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">
              Добавить
            </div>
            {members.filter((m) => m.id !== currentUserId).length <
              (memD?.members?.length ?? 0) && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {(memD?.members ?? []).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => void addMember(m.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 rounded hover:bg-emerald-50 text-left"
                  >
                    <UserPlus className="h-3 w-3 text-emerald-500" />
                    <span className="text-xs text-foreground">{m.login}</span>
                  </button>
                ))}
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
      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${active ? "bg-emerald-50 border-l-[3px] border-emerald-500" : "hover:bg-muted/50 border-l-[3px] border-transparent"}`}
    >
      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-lg shrink-0">
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
            <span className="text-xs text-muted-foreground truncate">
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

function FilePreviewImg({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={file.name}
      className="w-16 h-16 rounded-lg object-cover border"
    />
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
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
                  className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50 cursor-pointer"
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
                  <span className="text-xs text-foreground">{m.login}</span>
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
