"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { Menu, Loader2, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { TicketsSidebar } from "./tickets-sidebar";
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [wantsNewDialog, setWantsNewDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessageCount = useRef(0);

  const accent = config.chatAccentColor || "#22c55e";
  const persona = config.activePersona;
  const avatarSrc = personaAvatarSrc(persona?.avatarUrl);

  // ─── Data fetching (unchanged) ────────────────────────────────────────────

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

  // ─── Handlers (unchanged) ─────────────────────────────────────────────────

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
    setSidebarOpen(false);
  }

  const isClosed =
    activeTicket?.status === "CLOSED" || activeTicket?.status === "RESOLVED";
  const showNewTicketMode =
    !activeTicketId || (!activeTicket && !creatingTicket);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={`flex flex-col ${embedMode ? "h-screen" : "min-h-screen"}`}>
      {/* Main card */}
      <div
        className={`flex-1 flex flex-col ${
          embedMode
            ? ""
            : "mx-auto w-full max-w-[1000px] md:my-6 md:rounded-3xl md:shadow-2xl overflow-hidden"
        }`}
        style={{
          background:
            "linear-gradient(135deg, #fef3e2 0%, #fde8d8 40%, #f5e6f0 100%)",
        }}
      >
        {/* Header bar */}
        <div className="flex items-center gap-3 px-5 py-4">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded-lg hover:bg-white/40 transition-colors"
            aria-label="Открыть меню"
          >
            <Menu className="h-5 w-5 text-gray-600" />
          </button>
          <div className="flex items-center gap-2 flex-1">
            <span className="text-xl" style={{ color: accent }}>
              ✦
            </span>
            <h1 className="text-lg font-bold text-gray-800">
              {config.chatTitle}
            </h1>
          </div>
          <span className="text-xs text-gray-400">
            {persona ? `${persona.displayName} · ${persona.role}` : ""}
          </span>
        </div>

        {/* Two-column layout */}
        <div className="flex-1 flex flex-col md:flex-row gap-0 md:gap-6 px-4 md:px-6 pb-4 md:pb-6 overflow-hidden">
          {/* Left: messages */}
          <div className="flex-1 flex flex-col min-w-0 order-2 md:order-1">
            <div className="flex-1 overflow-y-auto pr-1 space-y-1">
              {showNewTicketMode ? (
                <div className="flex flex-col items-center justify-center h-full text-center py-8">
                  <p className="text-sm text-gray-400">
                    {tickets.length === 0
                      ? "Задайте свой первый вопрос"
                      : "Начните новый диалог"}
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
                    />
                  ))}
                  {isClosed && (
                    <div className="flex justify-center my-4">
                      <div className="bg-white/60 backdrop-blur rounded-full px-4 py-2 text-xs text-gray-500 flex items-center gap-2">
                        Диалог завершён
                        <button
                          onClick={handleNewDialog}
                          className="underline hover:text-gray-700"
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
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="mt-2 flex items-center gap-2 bg-red-50 text-red-600 text-sm rounded-xl px-3 py-2">
                <span className="flex-1">{error}</span>
                <button onClick={() => setError(null)}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Right: persona + input */}
          <div className="w-full md:w-[280px] shrink-0 flex flex-col items-center order-1 md:order-2 pb-4 md:pb-0">
            {/* Persona avatar (large, decorative) */}
            {persona && (
              <div className="mb-4 hidden md:block">
                <div
                  className="w-36 h-36 rounded-full p-1.5"
                  style={{
                    background: `linear-gradient(135deg, ${accent}40, ${accent}20)`,
                  }}
                >
                  {avatarSrc ? (
                    <Image
                      src={avatarSrc}
                      alt={persona.displayName}
                      width={144}
                      height={144}
                      className="w-full h-full rounded-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div
                      className="w-full h-full rounded-full flex items-center justify-center text-white text-4xl font-bold"
                      style={{ backgroundColor: accent }}
                    >
                      {persona.displayName[0]}
                    </div>
                  )}
                </div>
                <div className="text-center mt-2">
                  <div className="text-sm font-semibold text-gray-700">
                    {persona.displayName}
                  </div>
                  <div className="text-xs text-gray-400">{persona.role}</div>
                </div>
              </div>
            )}

            {/* Mobile: compact persona row */}
            {persona && (
              <div className="flex md:hidden items-center gap-3 w-full mb-3">
                <div
                  className="w-10 h-10 rounded-full p-0.5 shrink-0"
                  style={{
                    background: `linear-gradient(135deg, ${accent}40, ${accent}20)`,
                  }}
                >
                  {avatarSrc ? (
                    <Image
                      src={avatarSrc}
                      alt={persona.displayName}
                      width={40}
                      height={40}
                      className="w-full h-full rounded-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div
                      className="w-full h-full rounded-full flex items-center justify-center text-white text-sm font-bold"
                      style={{ backgroundColor: accent }}
                    >
                      {persona.displayName[0]}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-700">
                    {persona.displayName}
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {persona.role}
                  </div>
                </div>
              </div>
            )}

            {/* Prompt hint */}
            {showNewTicketMode && !embedMode && (
              <p className="text-sm text-gray-400 mb-2 text-center hidden md:block">
                {persona
                  ? `Спросите ${persona.displayName}...`
                  : "Задайте свой вопрос"}
              </p>
            )}

            {/* Input */}
            {!isClosed && (
              <div className="w-full">
                <MessageInput
                  onSend={(text) => {
                    if (showNewTicketMode) {
                      void handleCreateTicket(text);
                    } else {
                      void handleSendMessage(text);
                    }
                  }}
                  disabled={sending || creatingTicket}
                  placeholder={
                    showNewTicketMode ? "Задай свой вопрос" : "Ответить..."
                  }
                  accent={accent}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <TicketsSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        tickets={tickets}
        activeTicketId={activeTicketId}
        onSelect={(id) => {
          setWantsNewDialog(false);
          setActiveTicketId(id);
          setActiveTicket(null);
          setSidebarOpen(false);
        }}
        onNewDialog={handleNewDialog}
        onLogout={onLogout}
        accent={accent}
        customerName={customer.name ?? customer.email}
      />
    </div>
  );
}

// ─── MessageBubble ──────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  accent,
  personaAvatar,
}: {
  msg: ChatMessage;
  accent: string;
  personaAvatar: string | null;
}) {
  if (msg.authorType === "SYSTEM") {
    return (
      <div className="flex justify-center my-3">
        <span className="text-[11px] text-gray-400 bg-white/50 px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    );
  }

  const isCustomer = msg.authorType === "CUSTOMER";

  if (isCustomer) {
    return (
      <div className="flex justify-start mb-3">
        <div className="text-sm text-gray-600 font-medium">{msg.content}</div>
      </div>
    );
  }

  // Manager/Agent message — with avatar and gradient bubble
  return (
    <div className="flex items-start gap-2 mb-3">
      {personaAvatar ? (
        <Image
          src={personaAvatar}
          alt=""
          width={28}
          height={28}
          className="w-7 h-7 rounded-full object-cover shrink-0 mt-0.5"
          unoptimized
        />
      ) : (
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 mt-0.5"
          style={{ backgroundColor: accent }}
        >
          {msg.authorName[0]}
        </div>
      )}
      <div
        className="max-w-[85%] rounded-2xl rounded-tl-md px-4 py-2.5 text-white text-sm leading-relaxed"
        style={{
          background: `linear-gradient(135deg, ${accent}, ${accent}cc)`,
        }}
      >
        <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        <div className="text-[10px] mt-1 text-white/50">
          {formatDistanceToNow(new Date(msg.createdAt), {
            addSuffix: true,
            locale: ru,
          })}
        </div>
      </div>
    </div>
  );
}
