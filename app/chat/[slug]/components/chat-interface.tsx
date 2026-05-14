"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import {
  Plus,
  MessageSquare,
  Loader2,
  X,
  Clock,
  LogOut,
  MessageCircle,
  ChevronRight,
  Menu,
  Lock,
  Star,
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

const CATEGORY_OPTIONS = [
  {
    value: "GENERAL",
    label: "Общий вопрос",
    icon: "💬",
    hint: "Любые вопросы",
  },
  {
    value: "TECHNICAL",
    label: "Техническое",
    icon: "🔧",
    hint: "Проблемы с работой",
  },
  {
    value: "FINANCIAL",
    label: "Финансы",
    icon: "💰",
    hint: "Оплата и возвраты",
  },
  { value: "BUG", label: "Баг", icon: "🐛", hint: "Что-то сломалось" },
  {
    value: "FEATURE_REQUEST",
    label: "Предложение",
    icon: "💡",
    hint: "Новая функция",
  },
];

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
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
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
    }, 2000);
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
    if (!selectedCategory) return;
    setCreatingTicket(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${slug}/tickets`, {
        method: "POST",
        headers: authHeaders(token, csrf),
        body: JSON.stringify({
          title: firstMessage.slice(0, 100),
          description: firstMessage,
          category: selectedCategory,
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
    setSelectedCategory(null);
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
    <div className={`flex ${embedMode ? "h-screen" : "min-h-screen"} bg-white`}>
      {/* Mobile sidebar backdrop */}
      {mobileSidebar && (
        <div
          className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 md:hidden transition-opacity"
          onClick={() => setMobileSidebar(false)}
        />
      )}

      {/* ═══ LEFT SIDEBAR ═══ */}
      <aside
        className={`
          ${mobileSidebar ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0 fixed md:static inset-y-0 left-0 z-50 md:z-auto
          w-[280px] bg-gray-50/80 backdrop-blur-xl border-r border-gray-200/60 flex flex-col shrink-0 transition-transform md:transition-none
        `}
      >
        {/* Logo + title */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-200/60">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold shadow-sm"
            style={{
              backgroundColor: accent,
              boxShadow: `0 2px 8px ${accent}30`,
            }}
          >
            {config.workspaceName[0]}
          </div>
          <span className="font-semibold text-gray-800 text-sm truncate">
            {config.chatTitle}
          </span>
        </div>

        {/* New ticket button */}
        <div className="px-3 pt-3">
          <button
            onClick={handleNewDialog}
            className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:shadow-lg"
            style={{
              backgroundColor: accent,
              boxShadow: `0 2px 10px ${accent}25`,
            }}
          >
            <Plus className="h-4 w-4" />
            Новый тикет
          </button>
        </div>

        {/* Nav */}
        <nav className="px-3 pt-3 space-y-1">
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-gray-700 bg-white shadow-sm border border-gray-100">
            <MessageSquare className="h-4 w-4 text-gray-400" />
            <span className="font-medium">Все диалоги</span>
            {tickets.length > 0 && (
              <span className="ml-auto text-[10px] font-semibold bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">
                {tickets.length}
              </span>
            )}
          </div>
        </nav>

        {/* Recent dialogs */}
        <div className="px-3 pt-5 flex-1 min-h-0">
          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-3 mb-2">
            Недавние
          </div>
          <div className="space-y-0.5 max-h-[calc(100vh-320px)] overflow-y-auto">
            {tickets.length === 0 ? (
              <p className="text-xs text-gray-400 px-3 py-3">Нет диалогов</p>
            ) : (
              tickets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => selectTicket(t.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all duration-150 ${
                    t.id === activeTicketId
                      ? "bg-white shadow-sm border border-gray-100"
                      : "hover:bg-white/60"
                  }`}
                >
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[t.status] ?? "bg-gray-300"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-700 truncate">
                      {t.title}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-0.5">
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
        <div className="border-t border-gray-200/60 px-3 py-3">
          <div className="flex items-center gap-2.5 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-500">
              {(customer.name ?? customer.email)[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-gray-700 truncate">
                {customer.name ?? customer.email}
              </div>
            </div>
            <button
              onClick={onLogout}
              className="p-1.5 rounded-lg hover:bg-gray-200/80 transition-colors"
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
        <div className="flex items-center gap-3 px-4 md:px-5 py-3 border-b border-gray-100 shrink-0 bg-white/80 backdrop-blur-lg sticky top-0 z-10">
          <button
            onClick={() => setMobileSidebar(true)}
            className="md:hidden p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Меню"
          >
            <Menu className="h-5 w-5 text-gray-400" />
          </button>

          {persona && (
            <>
              <div className="relative">
                {avatarSrc ? (
                  <Image
                    src={avatarSrc}
                    alt={persona.displayName}
                    width={36}
                    height={36}
                    className="w-9 h-9 rounded-full object-cover ring-2 ring-white"
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
                {/* Online badge */}
                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-white" />
              </div>
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

          <div className="ml-auto flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] text-gray-400 font-medium">
              онлайн
            </span>
          </div>
        </div>

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
          {showNewTicketMode ? (
            <div className="flex flex-col items-center justify-center h-full animate-in fade-in duration-300">
              {!selectedCategory ? (
                <div className="w-full max-w-sm">
                  <div className="text-center mb-6">
                    <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-3">
                      <MessageCircle className="h-6 w-6 text-gray-300" />
                    </div>
                    <h3 className="text-sm font-semibold text-gray-700 mb-1">
                      Тема обращения
                    </h3>
                    <p className="text-xs text-gray-400">
                      Выберите категорию, чтобы мы быстрее помогли
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {CATEGORY_OPTIONS.map((cat) => (
                      <button
                        key={cat.value}
                        onClick={() => setSelectedCategory(cat.value)}
                        className="flex items-center gap-2.5 p-3.5 border border-gray-200 rounded-xl text-left hover:border-gray-300 hover:bg-gray-50/50 hover:shadow-sm transition-all duration-200 group"
                      >
                        <span className="text-lg group-hover:scale-110 transition-transform">
                          {cat.icon}
                        </span>
                        <div>
                          <div className="text-xs font-medium text-gray-700">
                            {cat.label}
                          </div>
                          <div className="text-[10px] text-gray-400">
                            {cat.hint}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full mb-3 border"
                    style={{
                      backgroundColor: `${accent}08`,
                      color: accent,
                      borderColor: `${accent}20`,
                    }}
                  >
                    {
                      CATEGORY_OPTIONS.find((c) => c.value === selectedCategory)
                        ?.icon
                    }{" "}
                    {
                      CATEGORY_OPTIONS.find((c) => c.value === selectedCategory)
                        ?.label
                    }
                    <button
                      onClick={() => setSelectedCategory(null)}
                      className="ml-1 hover:opacity-70 transition-opacity"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <h3 className="text-sm font-semibold text-gray-600 mb-1">
                    Опишите ваш вопрос
                  </h3>
                  <p className="text-xs text-gray-400 max-w-xs">
                    Приоритет определится автоматически
                  </p>
                </div>
              )}
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
                <CsatBlock
                  slug={slug}
                  token={token}
                  ticketId={activeTicket.id}
                  accent={accent}
                  onNewDialog={handleNewDialog}
                />
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
          <div className="mx-4 mb-2 flex items-center gap-2 bg-red-50 text-red-600 text-xs rounded-xl px-4 py-2.5 border border-red-100 animate-in fade-in duration-200">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="hover:opacity-70">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Input */}
        {!isClosed && (
          <div className="border-t border-gray-100 px-4 md:px-6 py-3 bg-white shrink-0">
            <MessageInput
              onSend={(text) => {
                if (showNewTicketMode) {
                  void handleCreateTicket(text);
                } else {
                  void handleSendMessage(text);
                }
              }}
              disabled={
                sending ||
                creatingTicket ||
                (showNewTicketMode && !selectedCategory)
              }
              placeholder={
                showNewTicketMode && !selectedCategory
                  ? "Сначала выберите тему обращения..."
                  : "Напишите сообщение..."
              }
              accent={accent}
            />
          </div>
        )}
      </main>

      {/* ═══ RIGHT SIDEBAR: Ticket details ═══ */}
      {activeTicket && (
        <aside className="hidden lg:flex w-[280px] border-l border-gray-100 flex-col shrink-0 bg-gray-50/50">
          <div className="px-5 py-4 border-b border-gray-100">
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
              Тикет
            </div>
            <div className="text-sm font-bold text-gray-800">
              #{activeTicket.number}
            </div>
          </div>

          <div className="px-5 py-4 space-y-4">
            {/* Status */}
            <div>
              <div className="text-[11px] text-gray-400 mb-1.5">Статус</div>
              <div className="flex items-center gap-2">
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
                <div className="text-[11px] text-gray-400 mb-1.5">
                  Приоритет
                </div>
                <span
                  className={`text-[11px] font-medium px-2.5 py-1 rounded-full ${PRIORITY_COLORS[(activeTicket as unknown as { priority: string }).priority] ?? "bg-gray-100 text-gray-600"}`}
                >
                  {PRIORITY_LABELS[
                    (activeTicket as unknown as { priority: string }).priority
                  ] ?? "Средний"}
                </span>
              </div>
            )}

            {/* Created */}
            <div>
              <div className="text-[11px] text-gray-400 mb-1.5">Создан</div>
              <div className="flex items-center gap-1.5 text-xs text-gray-600">
                <Clock className="h-3 w-3 text-gray-400" />
                {activeTicket.messages[0]
                  ? format(
                      new Date(activeTicket.messages[0].createdAt),
                      "d MMM yyyy, HH:mm",
                      { locale: ru },
                    )
                  : "—"}
              </div>
            </div>

            {/* Title */}
            <div>
              <div className="text-[11px] text-gray-400 mb-1.5">Тема</div>
              <div className="text-xs text-gray-700 leading-relaxed">
                {activeTicket.title}
              </div>
            </div>

            {/* Messages count */}
            <div>
              <div className="text-[11px] text-gray-400 mb-1.5">Сообщений</div>
              <div className="text-xs font-medium text-gray-600">
                {activeTicket.messages.length}
              </div>
            </div>
          </div>

          {/* New ticket button */}
          {!isClosed && (
            <div className="mt-auto px-5 py-4 border-t border-gray-100">
              <button
                onClick={handleNewDialog}
                className="w-full flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-medium border border-gray-200 text-gray-600 hover:bg-white hover:shadow-sm transition-all duration-200"
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
    const isTyping = msg.systemAction === "TYPING_STAGE";
    return (
      <div className="flex justify-center my-3">
        <span
          className={`text-[11px] px-3 py-1.5 rounded-full flex items-center gap-2 ${
            isTyping
              ? "text-emerald-600 bg-emerald-50 border border-emerald-200"
              : "text-gray-400 bg-gray-50 border border-gray-100"
          }`}
        >
          {isTyping && (
            <span className="flex gap-0.5">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce [animation-delay:300ms]" />
            </span>
          )}
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
    return (
      <div className="flex justify-end mb-4 group">
        <div className="max-w-[75%]">
          <div
            className="rounded-2xl rounded-br-md px-4 py-2.5 text-white text-sm shadow-sm"
            style={{
              backgroundColor: accent,
              boxShadow: `0 2px 8px ${accent}20`,
            }}
          >
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {msg.content}
            </p>
          </div>
          <div className="text-[10px] text-gray-400 text-right mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {timeStr}
          </div>
        </div>
      </div>
    );
  }

  // Manager: left-aligned
  return (
    <div className="flex items-start gap-2.5 mb-4 group">
      {personaAvatar ? (
        <Image
          src={personaAvatar}
          alt=""
          width={32}
          height={32}
          className="w-8 h-8 rounded-full object-cover shrink-0 mt-0.5 ring-2 ring-white shadow-sm"
          unoptimized
        />
      ) : (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0 mt-0.5"
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
        <div className="text-[10px] text-gray-400 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {timeStr}
        </div>
      </div>
    </div>
  );
}

// ─── CSAT Block ─────────────────────────────────────────────────────────────

function CsatBlock({
  slug,
  token,
  ticketId,
  accent,
  onNewDialog,
}: {
  slug: string;
  token: string;
  ticketId: string;
  accent: string;
  onNewDialog: () => void;
}) {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void fetch(`/api/chat/${slug}/tickets/${ticketId}/rate`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data: { rating?: { score: number } }) => {
        if (data.rating) setSubmitted(true);
      })
      .catch(() => {});
  }, [slug, token, ticketId]);

  async function handleSubmit() {
    if (!score) return;
    setSubmitting(true);
    try {
      await fetch(`/api/chat/${slug}/tickets/${ticketId}/rate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ score, comment: comment.trim() || undefined }),
      });
      setSubmitted(true);
    } catch {
      /* silent */
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="my-6 flex flex-col items-center animate-in fade-in duration-500">
      <div className="bg-gray-50 rounded-2xl px-6 py-5 max-w-sm w-full text-center border border-gray-100">
        <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center mx-auto mb-3">
          <Lock className="h-4 w-4 text-gray-400" />
        </div>
        <div className="text-xs text-gray-500 mb-3 font-medium">
          Диалог завершён
        </div>

        {!submitted ? (
          <>
            <div className="text-sm font-medium text-gray-700 mb-3">
              Оцените качество поддержки
            </div>
            <div className="flex justify-center gap-1.5 mb-3">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setScore(n)}
                  className="p-1 transition-all duration-200 hover:scale-125"
                >
                  <Star
                    className={`h-7 w-7 transition-colors ${
                      score && n <= score
                        ? "fill-amber-400 text-amber-400"
                        : "text-gray-200 hover:text-gray-300"
                    }`}
                  />
                </button>
              ))}
            </div>
            {score && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <textarea
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs resize-none mb-3 focus:outline-none focus:ring-2 focus:border-transparent"
                  style={
                    { "--tw-ring-color": `${accent}30` } as React.CSSProperties
                  }
                  rows={2}
                  placeholder="Комментарий (необязательно)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="w-full rounded-xl px-3 py-2.5 text-xs font-medium text-white transition-all duration-200 disabled:opacity-50 hover:shadow-lg"
                  style={{
                    backgroundColor: accent,
                    boxShadow: `0 2px 10px ${accent}25`,
                  }}
                >
                  {submitting ? "Отправка..." : "Отправить оценку"}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-gray-500">Спасибо за вашу оценку!</div>
        )}

        <button
          onClick={onNewDialog}
          className="mt-4 text-xs text-gray-400 hover:text-gray-600 transition-colors font-medium"
        >
          Создать новый диалог
        </button>
      </div>
    </div>
  );
}
