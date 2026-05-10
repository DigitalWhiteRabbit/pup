"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import {
  Plus,
  MessageSquare,
  Ticket,
  Loader2,
  X,
  Clock,
  LogOut,
  MessageCircle,
  ChevronRight,
  Menu,
  Lock,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { MessageInput } from "./message-input";
import type {
  ChatConfig,
  ChatCustomer,
  ChatTicketSummary,
  ChatTicketFull,
  ChatMessage,
} from "../types";

type Props = {
  slug: string;
  config: ChatConfig;
  token: string;
  csrf: string;
  customer: ChatCustomer;
  embedMode: boolean;
  onLogout: () => void;
};

function authHeaders(token: string, csrf?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (csrf) h["X-CSRF-Token"] = csrf;
  return h;
}

function personaAvatarSrc(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  return `/api/chat/avatars/${avatarUrl.replace(/^personas\//, "")}`;
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Открыт",
  IN_PROGRESS: "В работе",
  WAITING_CUSTOMER: "Ждёт ответа",
  RESOLVED: "Решён",
  CLOSED: "Закрыт",
};

const STATUS_COLORS: Record<string, string> = {
  OPEN: "bg-emerald-500",
  IN_PROGRESS: "bg-blue-500",
  WAITING_CUSTOMER: "bg-amber-500",
  RESOLVED: "bg-gray-400",
  CLOSED: "bg-gray-400",
};

const PRIORITY_LABELS: Record<string, string> = {
  LOW: "Низкий",
  MEDIUM: "Средний",
  HIGH: "Высокий",
  URGENT: "Срочный",
};

const PRIORITY_COLORS: Record<string, string> = {
  LOW: "bg-gray-100 text-gray-600",
  MEDIUM: "bg-amber-100 text-amber-700",
  HIGH: "bg-orange-100 text-orange-700",
  URGENT: "bg-red-100 text-red-700",
};

export function ChatInterface({
  slug,
  config,
  token,
  csrf,
  customer,
  embedMode,
  onLogout,
}: Props) {
  const [tickets, setTickets] = useState<ChatTicketSummary[]>([]);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [activeTicket, setActiveTicket] = useState<ChatTicketFull | null>(null);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [sending, setSending] = useState(false);
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [wantsNewDialog, setWantsNewDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessageCount = useRef(0);

  const accent = config.chatAccentColor || "#22c55e";
  const persona = config.activePersona;
  const avatarSrc = personaAvatarSrc(persona?.avatarUrl);

  // ─── Data fetching ────────────────────────────────────────────────────────

  const fetchTickets = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/${slug}/tickets`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { data: ChatTicketSummary[] };
      setTickets(data.data);
    } catch {
      /* silent */
    }
  }, [slug, token]);

  const fetchTicketDetail = useCallback(async () => {
    if (!activeTicketId) return;
    try {
      const res = await fetch(`/api/chat/${slug}/tickets/${activeTicketId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as ChatTicketFull;
      setActiveTicket(data);
    } catch {
      /* silent */
    }
  }, [slug, token, activeTicketId]);

  useEffect(() => {
    void fetchTickets();
  }, [fetchTickets]);

  useEffect(() => {
    if (wantsNewDialog) return;
    if (!activeTicketId && tickets.length > 0) {
      const open = tickets.find(
        (t) => t.status !== "CLOSED" && t.status !== "RESOLVED",
      );
      if (open) setActiveTicketId(open.id);
      else setActiveTicketId(tickets[0]?.id ?? null);
    }
  }, [tickets, activeTicketId, wantsNewDialog]);

  useEffect(() => {
    if (activeTicketId) void fetchTicketDetail();
  }, [activeTicketId, fetchTicketDetail]);

  useEffect(() => {
    if (!activeTicketId) return;
    const interval = setInterval(() => {
      void fetchTicketDetail();
      void fetchTickets();
    }, 5000);
    return () => clearInterval(interval);
  }, [activeTicketId, fetchTicketDetail, fetchTickets]);

  useEffect(() => {
    const count = activeTicket?.messages.length ?? 0;
    if (count > prevMessageCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMessageCount.current = count;
  }, [activeTicket?.messages.length]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  async function handleCreateTicket(firstMessage: string) {
    setCreatingTicket(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${slug}/tickets`, {
        method: "POST",
        headers: authHeaders(token, csrf),
        body: JSON.stringify({
          title: firstMessage.slice(0, 100),
          description: firstMessage,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ?? "Ошибка создания тикета",
        );
      }
      const ticket = (await res.json()) as ChatTicketFull;
      setWantsNewDialog(false);
      setActiveTicketId(ticket.id);
      setActiveTicket(ticket);
      await fetchTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setCreatingTicket(false);
    }
  }

  async function handleSendMessage(content: string) {
    if (!activeTicketId) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/chat/${slug}/tickets/${activeTicketId}/messages`,
        {
          method: "POST",
          headers: authHeaders(token, csrf),
          body: JSON.stringify({ content }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ?? "Ошибка отправки",
        );
      }
      await fetchTicketDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setSending(false);
    }
  }

  function handleNewDialog() {
    setWantsNewDialog(true);
    setActiveTicketId(null);
    setActiveTicket(null);
    setMobileSidebar(false);
  }

  function selectTicket(id: string) {
    setWantsNewDialog(false);
    setActiveTicketId(id);
    setActiveTicket(null);
    setMobileSidebar(false);
  }

  const isClosed =
    activeTicket?.status === "CLOSED" || activeTicket?.status === "RESOLVED";
  const showNewTicketMode =
    !activeTicketId || (!activeTicket && !creatingTicket);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={`flex ${embedMode ? "h-screen" : "min-h-screen"}`}>
      {/* ═══ Mobile sidebar toggle (backdrop) ═══ */}
      {mobileSidebar && (
        <div
          className="fixed inset-0 bg-black/30 z-40 md:hidden"
          onClick={() => setMobileSidebar(false)}
        />
      )}

      {/* ═══ LEFT SIDEBAR ═══ */}
      <aside
        className={`
          ${mobileSidebar ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0 fixed md:static inset-y-0 left-0 z-50 md:z-auto
          w-[280px] bg-gray-50 border-r flex flex-col shrink-0 transition-transform md:transition-none
        `}
      >
        {/* Logo + title */}
        <div className="flex items-center gap-2 px-4 py-4 border-b">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold"
            style={{ backgroundColor: accent }}
          >
            {config.workspaceName[0]}
          </div>
          <span className="font-semibold text-gray-800 text-sm">
            {config.chatTitle}
          </span>
        </div>

        {/* New ticket button */}
        <div className="px-3 pt-3">
          <button
            onClick={handleNewDialog}
            className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white transition-colors"
            style={{ backgroundColor: accent }}
          >
            <Plus className="h-4 w-4" />
            Новый тикет
          </button>
        </div>

        {/* Nav */}
        <nav className="px-3 pt-3 space-y-0.5">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 bg-white shadow-sm">
            <MessageSquare className="h-4 w-4" />
            Все диалоги
            {tickets.length > 0 && (
              <span className="ml-auto text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">
                {tickets.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-white/60 cursor-pointer transition-colors">
            <Ticket className="h-4 w-4" />
            Мои тикеты
          </div>
        </nav>

        {/* Recent dialogs */}
        <div className="px-3 pt-4">
          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide px-3 mb-2">
            Недавние диалоги
          </div>
          <div className="space-y-0.5 max-h-[300px] overflow-y-auto">
            {tickets.length === 0 ? (
              <p className="text-xs text-gray-400 px-3 py-2">Нет диалогов</p>
            ) : (
              tickets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => selectTicket(t.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                    t.id === activeTicketId
                      ? "bg-white shadow-sm"
                      : "hover:bg-white/60"
                  }`}
                >
                  {/* Status dot */}
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[t.status] ?? "bg-gray-300"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-700 truncate">
                      {t.title}
                    </div>
                    <div className="text-[10px] text-gray-400">
                      #{t.number} ·{" "}
                      {formatDistanceToNow(new Date(t.lastMessageAt), {
                        addSuffix: true,
                        locale: ru,
                      })}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Bottom: user + logout */}
        <div className="mt-auto border-t px-3 py-3">
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-500">
              {(customer.name ?? customer.email)[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-gray-700 truncate">
                {customer.name ?? customer.email}
              </div>
            </div>
            <button
              onClick={onLogout}
              className="p-1 rounded hover:bg-gray-200 transition-colors"
              title="Выйти"
            >
              <LogOut className="h-3.5 w-3.5 text-gray-400" />
            </button>
          </div>
        </div>
      </aside>

      {/* ═══ CENTER: CHAT ═══ */}
      <main className="flex-1 flex flex-col min-w-0 bg-white">
        {/* Chat header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
          {/* Mobile menu */}
          <button
            onClick={() => setMobileSidebar(true)}
            className="md:hidden p-1 rounded hover:bg-gray-100"
            aria-label="Меню"
          >
            <Menu className="h-5 w-5 text-gray-500" />
          </button>

          {persona && (
            <>
              {avatarSrc ? (
                <Image
                  src={avatarSrc}
                  alt={persona.displayName}
                  width={36}
                  height={36}
                  className="w-9 h-9 rounded-full object-cover"
                  unoptimized
                />
              ) : (
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold"
                  style={{ backgroundColor: accent }}
                >
                  {persona.displayName[0]}
                </div>
              )}
              <div>
                <div className="text-sm font-semibold text-gray-800">
                  {persona.displayName}
                </div>
                <div className="text-[11px] text-gray-400">{persona.role}</div>
              </div>
            </>
          )}
          {!persona && (
            <div className="text-sm font-semibold text-gray-800">
              {config.chatTitle}
            </div>
          )}

          {/* Online indicator */}
          <div className="ml-auto flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-[11px] text-gray-400">онлайн</span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
          {showNewTicketMode ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <MessageCircle className="h-10 w-10 text-gray-200 mb-3" />
              <h3 className="text-sm font-semibold text-gray-600 mb-1">
                {tickets.length === 0
                  ? "Начните первый диалог"
                  : "Новый диалог"}
              </h3>
              <p className="text-xs text-gray-400 max-w-xs">
                Напишите ваш вопрос ниже
              </p>
            </div>
          ) : activeTicket ? (
            <>
              {activeTicket.messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  accent={accent}
                  personaAvatar={avatarSrc}
                  personaName={persona?.displayName}
                />
              ))}
              {isClosed && (
                <div className="flex justify-center my-4">
                  <div className="bg-gray-100 rounded-full px-4 py-2 text-xs text-gray-500 flex items-center gap-2">
                    <Lock className="h-3 w-3" />
                    Диалог завершён
                    <button
                      onClick={handleNewDialog}
                      className="underline hover:text-gray-700 ml-1"
                    >
                      Создать новый
                    </button>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          ) : (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-gray-300" />
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-4 mb-2 flex items-center gap-2 bg-red-50 text-red-600 text-xs rounded-lg px-3 py-2">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)}>
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Input */}
        {!isClosed && (
          <div className="border-t px-4 md:px-6 py-3 bg-white shrink-0">
            <MessageInput
              onSend={(text) => {
                if (showNewTicketMode) {
                  void handleCreateTicket(text);
                } else {
                  void handleSendMessage(text);
                }
              }}
              disabled={sending || creatingTicket}
              placeholder="Напишите сообщение..."
              accent={accent}
            />
          </div>
        )}
      </main>

      {/* ═══ RIGHT SIDEBAR: Ticket details ═══ */}
      {activeTicket && (
        <aside className="hidden lg:flex w-[280px] border-l flex-col shrink-0 bg-gray-50/50">
          <div className="px-4 py-4 border-b">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
              Тикет
            </div>
            <div className="text-sm font-semibold text-gray-800">
              #{activeTicket.number}
            </div>
          </div>

          <div className="px-4 py-3 space-y-3">
            {/* Status */}
            <div>
              <div className="text-[11px] text-gray-400 mb-1">Статус</div>
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${STATUS_COLORS[activeTicket.status] ?? "bg-gray-300"}`}
                />
                <span className="text-xs font-medium text-gray-700">
                  {STATUS_LABELS[activeTicket.status] ?? activeTicket.status}
                </span>
              </div>
            </div>

            {/* Priority */}
            {"priority" in activeTicket && (
              <div>
                <div className="text-[11px] text-gray-400 mb-1">Приоритет</div>
                <span
                  className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${PRIORITY_COLORS[(activeTicket as unknown as { priority: string }).priority] ?? "bg-gray-100 text-gray-600"}`}
                >
                  {PRIORITY_LABELS[
                    (activeTicket as unknown as { priority: string }).priority
                  ] ?? "Средний"}
                </span>
              </div>
            )}

            {/* Created */}
            <div>
              <div className="text-[11px] text-gray-400 mb-1">Создан</div>
              <div className="flex items-center gap-1 text-xs text-gray-600">
                <Clock className="h-3 w-3" />
                {activeTicket.messages[0]
                  ? format(
                      new Date(activeTicket.messages[0].createdAt),
                      "d MMM yyyy, HH:mm",
                      { locale: ru },
                    )
                  : "—"}
              </div>
            </div>

            {/* Title / description */}
            <div>
              <div className="text-[11px] text-gray-400 mb-1">Тема</div>
              <div className="text-xs text-gray-700">{activeTicket.title}</div>
            </div>

            {/* Messages count */}
            <div>
              <div className="text-[11px] text-gray-400 mb-1">Сообщений</div>
              <div className="text-xs text-gray-600">
                {activeTicket.messages.length}
              </div>
            </div>
          </div>

          {/* Close ticket button */}
          {!isClosed && (
            <div className="mt-auto px-4 py-4 border-t">
              <button
                onClick={handleNewDialog}
                className="w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <ChevronRight className="h-3.5 w-3.5" />
                Новый тикет
              </button>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

// ─── MessageBubble ──────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  accent,
  personaAvatar,
  personaName,
}: {
  msg: ChatMessage;
  accent: string;
  personaAvatar: string | null;
  personaName?: string;
}) {
  if (msg.authorType === "SYSTEM") {
    return (
      <div className="flex justify-center my-3">
        <span className="text-[11px] text-gray-400 bg-gray-100 px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    );
  }

  const isCustomer = msg.authorType === "CUSTOMER";
  const timeStr = formatDistanceToNow(new Date(msg.createdAt), {
    addSuffix: true,
    locale: ru,
  });

  if (isCustomer) {
    // Customer: right-aligned, dark bubble
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[75%]">
          <div
            className="rounded-2xl rounded-br-md px-4 py-2.5 text-white text-sm"
            style={{ backgroundColor: "#374151" }}
          >
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {msg.content}
            </p>
          </div>
          <div className="text-[10px] text-gray-400 text-right mt-1">
            {timeStr}
          </div>
        </div>
      </div>
    );
  }

  // Manager: left-aligned, light bubble with avatar
  return (
    <div className="flex items-start gap-2 mb-3">
      {personaAvatar ? (
        <Image
          src={personaAvatar}
          alt=""
          width={28}
          height={28}
          className="w-7 h-7 rounded-full object-cover shrink-0 mt-1"
          unoptimized
        />
      ) : (
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-1"
          style={{ backgroundColor: accent }}
        >
          {(personaName ?? msg.authorName)[0]}
        </div>
      )}
      <div className="max-w-[75%]">
        <div className="bg-gray-100 rounded-2xl rounded-tl-md px-4 py-2.5 text-sm text-gray-800">
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {msg.content}
          </p>
        </div>
        <div className="text-[10px] text-gray-400 mt-1">{timeStr}</div>
      </div>
    </div>
  );
}
