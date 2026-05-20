"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Send,
  CornerDownRight,
  X,
  Pencil,
  Trash2,
  Check,
  Paperclip,
  FileText,
  Download,
  Search,
  Bookmark,
  ChevronDown,
  MessageCircle,
} from "lucide-react";
import { UserAvatar } from "@/components/ui/user-avatar";
import { MessageContent } from "@/components/chat/message-content";
import { VoiceRecorder, VoicePlayer } from "@/components/chat/voice-recorder";
import { LinkPreview, extractUrl } from "@/components/chat/link-preview";

/* ── Types ── */

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
  authorHasAvatar: boolean;
  content: string;
  parentId: string | null;
  editedAt: string | null;
  createdAt: string;
  replyTo: { authorLogin: string; content: string } | null;
  reactions: Array<{ emoji: string; count: number; myReaction: boolean }>;
  attachments: MsgAttachment[];
};

type ChatUser = {
  id: string;
  login: string;
  role: string;
  hasAvatar: boolean;
  online: boolean;
};

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🔥"];

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/* ── Main Component ── */

export function GlobalChatClient({
  currentUserId,
  currentUserLogin: _login,
}: {
  currentUserId: string;
  currentUserLogin: string;
}) {
  const qc = useQueryClient();
  const [msgText, setMsgText] = useState("");
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [mobileShowMembers, setMobileShowMembers] = useState(false);

  /* ── Data fetching ── */

  const { data } = useQuery<{ data: Msg[] }>({
    queryKey: ["global-chat"],
    queryFn: () => fetch("/api/global-chat").then((r) => r.json()),
    refetchInterval: 3000,
  });
  const msgs = data?.data ?? [];

  const { data: allUsers = [] } = useQuery<ChatUser[]>({
    queryKey: ["users", "all"],
    queryFn: () => fetch("/api/users/all").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const onlineUsers = allUsers.filter((u) => u.online);
  const offlineUsers = allUsers.filter((u) => !u.online);
  const filteredOnline = memberSearch
    ? onlineUsers.filter((u) =>
        u.login.toLowerCase().includes(memberSearch.toLowerCase()),
      )
    : onlineUsers;
  const filteredOffline = memberSearch
    ? offlineUsers.filter((u) =>
        u.login.toLowerCase().includes(memberSearch.toLowerCase()),
      )
    : offlineUsers;

  // Search messages
  const searchResults = searchQuery.trim()
    ? msgs.filter((m) =>
        m.content.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  // Scroll listener for scroll-to-bottom button
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      setShowScrollBtn(!atBottom);
    }
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  /* ── Mutations ── */

  const sendMut = useMutation({
    mutationFn: async (args: {
      content: string;
      parentId?: string;
      files: File[];
    }) => {
      const r = await fetch("/api/global-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: args.content,
          parentId: args.parentId,
        }),
      });
      if (!r.ok) throw new Error("Ошибка");
      const msg = await r.json();
      for (const file of args.files) {
        const fd = new FormData();
        fd.append("file", file);
        await fetch(`/api/global-chat/${msg.id}/attachments`, {
          method: "POST",
          body: fd,
        });
      }
      return msg;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["global-chat"] });
      setMsgText("");
      setReplyTo(null);
      setPendingFiles([]);
    },
  });

  function send() {
    const t = msgText.trim();
    if (t || pendingFiles.length > 0)
      sendMut.mutate({
        content: t || (pendingFiles.length > 0 ? "📎" : ""),
        parentId: replyTo?.id,
        files: pendingFiles,
      });
  }

  async function react(msgId: string, emoji: string) {
    await fetch(`/api/global-chat/${msgId}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    });
    void qc.invalidateQueries({ queryKey: ["global-chat"] });
  }

  async function saveEdit(msgId: string) {
    if (!editText.trim()) return;
    await fetch(`/api/global-chat/${msgId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editText.trim() }),
    });
    setEditingMsgId(null);
    setEditText("");
    void qc.invalidateQueries({ queryKey: ["global-chat"] });
  }

  async function deleteMsg(msgId: string) {
    await fetch(`/api/global-chat/${msgId}`, { method: "DELETE" });
    void qc.invalidateQueries({ queryKey: ["global-chat"] });
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) setPendingFiles((prev) => [...prev, ...files]);
  }

  function scrollToBottom() {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  /* ── Render ── */

  return (
    <div className="flex h-[100dvh] md:h-screen" style={{ marginTop: "-1px" }}>
      {/* ═══ LEFT: Members Panel ═══ */}
      <aside
        className={`w-full md:w-[260px] bg-card border-r border flex-col shrink-0 ${mobileShowMembers ? "flex" : "hidden"} lg:flex`}
      >
        {/* Members header */}
        <div className="px-5 py-4 border-b border">
          <h2 className="text-[15px] font-bold text-foreground">Участники</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Все пользователи системы
          </p>
        </div>

        {/* Search */}
        <div className="px-4 py-3">
          <input
            type="text"
            placeholder="Поиск..."
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            className="w-full px-3 py-2 bg-muted border border rounded-[10px] text-foreground text-xs outline-none placeholder:text-muted-foreground focus:border-emerald-500 transition-colors"
          />
        </div>

        {/* Members list */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {/* Online */}
          {filteredOnline.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center gap-1.5 text-[9px] font-bold text-muted-foreground/60 uppercase tracking-widest mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Онлайн — {filteredOnline.length}
              </div>
              {filteredOnline.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-muted transition-colors cursor-default"
                >
                  <div className="relative shrink-0">
                    <UserAvatar
                      userId={u.hasAvatar ? u.id : undefined}
                      login={u.login}
                      size={32}
                    />
                    <span className="absolute -bottom-px -right-px w-2.5 h-2.5 bg-emerald-500 border-2 border-card rounded-full" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] text-foreground font-medium truncate">
                      {u.login}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60">
                      {u.role === "ADMIN" ? "Администратор" : "Пользователь"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Offline */}
          {filteredOffline.length > 0 && (
            <div>
              <div className="text-[9px] font-bold text-muted-foreground/60 uppercase tracking-widest mb-2">
                Офлайн — {filteredOffline.length}
              </div>
              {filteredOffline.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg opacity-50 cursor-default"
                >
                  <UserAvatar
                    userId={u.hasAvatar ? u.id : undefined}
                    login={u.login}
                    size={32}
                  />
                  <div className="min-w-0">
                    <div className="text-[13px] text-foreground font-medium truncate">
                      {u.login}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60">
                      {u.role === "ADMIN" ? "Администратор" : "Пользователь"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ═══ CENTER: Chat ═══ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-4 md:px-6 py-3 md:py-4 border-b border shrink-0 bg-card flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center text-lg">
              💬
            </div>
            <div>
              <h2 className="text-[15px] font-bold text-foreground">
                Общий чат
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {allUsers.length} участников · {onlineUsers.length} онлайн
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setMobileShowMembers(!mobileShowMembers)}
              className={`w-9 h-9 rounded-[10px] border flex lg:hidden items-center justify-center transition-colors ${mobileShowMembers ? "border-emerald-500 bg-emerald-500/10 text-emerald-400" : "border text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              title="Участники"
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
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
            <button
              onClick={() => {
                setSearchOpen(!searchOpen);
              }}
              className={`w-9 h-9 rounded-[10px] border flex items-center justify-center transition-colors ${searchOpen ? "border-emerald-500 bg-emerald-500/10 text-emerald-400" : "border text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              title="Поиск"
            >
              <Search className="w-4 h-4" />
            </button>
            <button
              className="w-9 h-9 rounded-[10px] border text-muted-foreground flex items-center justify-center hover:bg-muted hover:text-foreground transition-colors"
              title="Закреплённые"
            >
              <Bookmark className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search panel */}
        {searchOpen && (
          <div className="border-b border bg-card px-4 md:px-6 py-3 animate-in slide-in-from-top-2 duration-200">
            <input
              type="text"
              placeholder="Поиск по сообщениям..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-4 py-2 bg-background border border rounded-lg text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-emerald-500 transition-colors"
              autoFocus
            />
            {searchResults.length > 0 && (
              <div className="mt-2 max-h-[200px] overflow-y-auto space-y-px rounded-lg border bg-muted">
                {searchResults.slice(0, 10).map((m) => (
                  <button
                    key={m.id}
                    className="w-full text-left px-3 py-2.5 hover:bg-muted transition-colors"
                    onClick={() => {
                      setSearchOpen(false);
                      setSearchQuery("");
                      const el = document.getElementById(`gmsg-${m.id}`);
                      if (el) {
                        el.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        });
                        setHighlightMsgId(m.id);
                        setTimeout(() => setHighlightMsgId(null), 2000);
                      }
                    }}
                  >
                    <div className="text-[11px] font-semibold text-muted-foreground">
                      {m.authorLogin} · {format(new Date(m.createdAt), "HH:mm")}
                    </div>
                    <div className="text-[12px] text-muted-foreground mt-0.5 truncate">
                      {m.content}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        <div
          ref={messagesRef}
          className={`flex-1 overflow-y-auto overflow-x-hidden px-3 md:px-6 py-4 md:py-5 min-h-0 flex flex-col relative bg-background ${dragOver ? "bg-emerald-900/10" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleFileDrop}
        >
          {dragOver && (
            <div className="absolute inset-4 flex items-center justify-center bg-emerald-900/30 z-10 border-2 border-dashed border-emerald-400 rounded-2xl backdrop-blur-sm animate-in fade-in duration-200">
              <div className="text-center">
                <Paperclip className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                <div className="text-emerald-400 font-medium text-sm">
                  Перетащите файлы сюда
                </div>
              </div>
            </div>
          )}

          {msgs.length === 0 && (
            <div className="flex flex-col items-center justify-center flex-1 text-center">
              <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-3">
                <MessageCircle className="h-7 w-7 text-muted-foreground/60" />
              </div>
              <p className="text-sm text-muted-foreground/60">
                Нет сообщений. Начните диалог!
              </p>
            </div>
          )}

          <div className="flex-1" />
          {msgs.map((m, idx) => {
            const isMe = m.authorId === currentUserId;
            const prevMsg = msgs[idx - 1];
            const isContinuation =
              prevMsg?.authorId === m.authorId &&
              new Date(m.createdAt).getTime() -
                new Date(prevMsg.createdAt).getTime() <
                120000;
            return (
              <div
                key={m.id}
                id={`gmsg-${m.id}`}
                className={`group flex transition-colors duration-700 rounded-xl ${isContinuation ? "mt-1" : "mt-3"} ${isMe ? "flex-row-reverse" : ""} ${highlightMsgId === m.id ? "bg-emerald-900/20" : ""}`}
              >
                {/* Avatar */}
                <div
                  className={`w-9 shrink-0 ${isMe ? "ml-2.5" : "mr-2.5"} flex flex-col justify-start`}
                >
                  {!isContinuation ? (
                    <UserAvatar
                      userId={m.authorHasAvatar ? m.authorId : undefined}
                      login={m.authorLogin}
                      size={36}
                      className="mt-0.5"
                    />
                  ) : (
                    <div className="w-9" />
                  )}
                </div>

                <div
                  className={`max-w-[85%] md:max-w-[65%] flex flex-col ${isMe ? "items-end" : "items-start"}`}
                >
                  {/* Author + time */}
                  {!isContinuation && (
                    <div
                      className={`flex items-center gap-2 mb-1 ${isMe ? "flex-row-reverse" : ""}`}
                    >
                      <span className="text-[12px] font-semibold text-foreground">
                        {m.authorLogin}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {format(new Date(m.createdAt), "HH:mm", { locale: ru })}
                      </span>
                      {m.editedAt && (
                        <span className="text-[10px] text-muted-foreground/60 italic">
                          изм.
                        </span>
                      )}
                    </div>
                  )}

                  {/* Bubble */}
                  <div
                    className={`rounded-[18px] px-4 py-2.5 text-sm whitespace-pre-wrap break-words max-w-[min(85%,700px)] ${
                      isMe
                        ? "bg-emerald-500 text-white rounded-br-[6px]"
                        : "bg-muted border border text-foreground rounded-bl-[6px]"
                    }`}
                  >
                    {/* Reply */}
                    {m.replyTo && m.parentId && (
                      <button
                        type="button"
                        className={`mb-2 pl-2.5 border-l-2 text-xs text-left w-full rounded-r py-1 transition-colors ${isMe ? "border-white/40 hover:bg-white/10" : "border-emerald-500 bg-emerald-500/5 hover:bg-emerald-500/10"}`}
                        onClick={() => {
                          const el = document.getElementById(
                            `gmsg-${m.parentId}`,
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
                          className={`font-semibold ${isMe ? "text-white/80" : "text-emerald-500"}`}
                        >
                          {m.replyTo.authorLogin}
                        </div>
                        <div
                          className={`truncate ${isMe ? "text-white/60" : "text-muted-foreground"}`}
                        >
                          {m.replyTo.content}
                        </div>
                      </button>
                    )}

                    {/* Content */}
                    {editingMsgId === m.id ? (
                      <div className="flex flex-col gap-2">
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              void saveEdit(m.id);
                            }
                            if (e.key === "Escape") setEditingMsgId(null);
                          }}
                          className="w-full bg-transparent outline-none resize-none text-sm min-h-[20px]"
                          autoFocus
                        />
                        <div className="flex gap-1.5 justify-end">
                          <button
                            onClick={() => setEditingMsgId(null)}
                            className={`text-[10px] px-2.5 py-1 rounded-full ${isMe ? "text-white/70 hover:bg-white/10" : "text-muted-foreground hover:bg-muted"}`}
                          >
                            Отмена
                          </button>
                          <button
                            onClick={() => void saveEdit(m.id)}
                            className={`text-[10px] px-2.5 py-1 rounded-full font-medium ${isMe ? "bg-white/20 text-white" : "bg-emerald-500/20 text-emerald-400"}`}
                          >
                            <Check className="h-3 w-3 inline mr-0.5" />
                            Сохранить
                          </button>
                        </div>
                      </div>
                    ) : (
                      <MessageContent content={m.content} isMe={isMe} />
                    )}

                    {/* Attachments */}
                    {m.attachments?.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {m.attachments.map((att) => {
                          const isImage = att.mimeType.startsWith("image/");
                          const isAudio = att.mimeType.startsWith("audio/");
                          return isImage ? (
                            <button
                              key={att.id}
                              type="button"
                              onClick={() =>
                                setLightboxUrl(
                                  `/api/global-chat-attachments/${att.id}`,
                                )
                              }
                              className="block"
                            >
                              <img
                                src={`/api/global-chat-attachments/${att.id}`}
                                alt={att.originalName}
                                className="max-w-[200px] max-h-[130px] rounded-xl object-cover cursor-pointer hover:opacity-90 transition-opacity"
                              />
                            </button>
                          ) : isAudio ? (
                            <div key={att.id}>
                              <VoicePlayer
                                src={`/api/global-chat-attachments/${att.id}`}
                                isMe={isMe}
                              />
                            </div>
                          ) : (
                            <a
                              key={att.id}
                              href={`/api/global-chat-attachments/${att.id}?download=1`}
                              className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-xs ${isMe ? "bg-white/10 hover:bg-white/20 text-white" : "bg-muted/80 hover:bg-muted text-foreground"}`}
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

                    {/* Link preview */}
                    {(() => {
                      const url = extractUrl(m.content);
                      return url ? <LinkPreview url={url} isMe={isMe} /> : null;
                    })()}
                  </div>

                  {/* Reactions */}
                  {m.reactions.length > 0 && (
                    <div
                      className={`flex gap-1 mt-1 ${isMe ? "justify-end" : ""}`}
                    >
                      {m.reactions.map((r) => (
                        <button
                          key={r.emoji}
                          onClick={() => void react(m.id, r.emoji)}
                          className={`flex items-center gap-1 rounded-[10px] px-2 py-0.5 text-[11px] border cursor-pointer transition-colors ${r.myReaction ? "bg-emerald-500/10 border-emerald-500" : "bg-muted/80 border hover:bg-muted"}`}
                        >
                          {r.emoji}{" "}
                          <span className="text-muted-foreground">
                            {r.count}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Hover actions */}
                  <div
                    className={`opacity-0 group-hover:opacity-100 flex gap-0.5 mt-1 transition-opacity ${isMe ? "flex-row-reverse" : ""}`}
                  >
                    <button
                      onClick={() => setReplyTo(m)}
                      className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      title="Ответить"
                    >
                      <CornerDownRight className="h-3 w-3" />
                    </button>
                    {isMe && (
                      <>
                        <button
                          onClick={() => {
                            setEditingMsgId(m.id);
                            setEditText(m.content);
                          }}
                          className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          title="Редактировать"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm("Удалить сообщение?"))
                              void deleteMsg(m.id);
                          }}
                          className="p-1.5 rounded-lg hover:bg-red-900/30 text-muted-foreground hover:text-red-400 transition-colors"
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
                        className="p-1.5 rounded-lg hover:bg-muted text-xs transition-all hover:scale-110"
                      >
                        {e}
                      </button>
                    ))}
                    {isContinuation && (
                      <span className="text-[10px] text-muted-foreground/60 self-center ml-1">
                        {format(new Date(m.createdAt), "HH:mm", { locale: ru })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />

          {/* Scroll to bottom */}
          {showScrollBtn && (
            <button
              onClick={scrollToBottom}
              className="sticky bottom-4 self-end w-11 h-11 rounded-full bg-muted border text-muted-foreground flex items-center justify-center shadow-lg hover:bg-muted/80 hover:text-foreground hover:border-emerald-500 transition-all z-20"
            >
              <ChevronDown className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Lightbox */}
        {lightboxUrl && (
          <div
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center cursor-pointer animate-in fade-in duration-200"
            onClick={() => setLightboxUrl(null)}
          >
            <button
              onClick={() => setLightboxUrl(null)}
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
            >
              <X className="h-5 w-5 text-white" />
            </button>
            <img
              src={lightboxUrl}
              alt=""
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-2xl shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}

        {/* Reply indicator */}
        {replyTo && (
          <div className="bg-muted border-t border px-3 md:px-6 py-2 flex items-center gap-2.5 text-xs text-muted-foreground shrink-0 animate-in slide-in-from-bottom-2 duration-200">
            <CornerDownRight className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            <span className="truncate">
              Ответ: <b className="text-foreground">{replyTo.authorLogin}</b>:{" "}
              {replyTo.content.slice(0, 60)}
            </span>
            <button
              onClick={() => setReplyTo(null)}
              className="ml-auto p-1 rounded hover:bg-muted shrink-0 text-muted-foreground/60"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Pending files */}
        {pendingFiles.length > 0 && (
          <div className="bg-card border-t border px-3 md:px-6 py-3 flex gap-2.5 flex-wrap shrink-0">
            {pendingFiles.map((f, i) => (
              <div key={i} className="relative group/file">
                {f.type.startsWith("image/") ? (
                  <img
                    src={URL.createObjectURL(f)}
                    alt={f.name}
                    className="w-16 h-16 rounded-xl object-cover border"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-xl border bg-muted flex flex-col items-center justify-center text-[9px] text-muted-foreground px-1">
                    <FileText className="h-5 w-5 mb-0.5" />
                    <span className="truncate w-full text-center">
                      {f.name}
                    </span>
                  </div>
                )}
                <button
                  onClick={() =>
                    setPendingFiles((prev) => prev.filter((_, j) => j !== i))
                  }
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-[10px] opacity-0 group-hover/file:opacity-100 transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="border-t border px-3 md:px-6 py-3 md:py-4 shrink-0 bg-card">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            accept="image/*,.pdf,.doc,.docx,.zip,.mp4,.mp3,.txt,audio/*"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0)
                setPendingFiles((prev) => [...prev, ...files]);
              e.target.value = "";
            }}
          />
          <div className="flex items-end gap-2.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              title="Прикрепить файл"
            >
              <Paperclip className="w-5 h-5" />
            </button>
            <div className="flex-1 bg-muted border rounded-[20px] px-[18px] py-2.5 focus-within:border-emerald-500 transition-colors">
              <textarea
                value={msgText}
                onChange={(e) => setMsgText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Напишите сообщение..."
                rows={1}
                className="w-full bg-transparent text-sm outline-none resize-none min-h-[20px] max-h-[120px] text-foreground placeholder:text-muted-foreground"
              />
            </div>
            {msgText.trim() || pendingFiles.length > 0 ? (
              <button
                className="w-10 h-10 rounded-xl bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center shrink-0 disabled:opacity-40 text-white transition-colors"
                disabled={sendMut.isPending}
                onClick={send}
              >
                <Send className="w-[18px] h-[18px]" />
              </button>
            ) : (
              <VoiceRecorder
                onRecorded={(file) =>
                  sendMut.mutate({
                    content: "🎤 Голосовое сообщение",
                    files: [file],
                  })
                }
                disabled={sendMut.isPending}
              />
            )}
          </div>
          <div className="text-[10px] text-muted-foreground/60 mt-1.5 pl-[52px] hidden md:block">
            Enter — отправить · Shift+Enter — новая строка · 🎤 голосовое
          </div>
        </div>
      </div>
    </div>
  );
}
