"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Menu, Send, Loader2, X } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessageCount = useRef(0);

  const accent = config.chatAccentColor || "#22c55e";
  const persona = config.activePersona;

  // Fetch tickets list
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

  // Fetch active ticket detail
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

  // Initial load
  useEffect(() => {
    void fetchTickets();
  }, [fetchTickets]);

  // Auto-select last open ticket
  useEffect(() => {
    if (!activeTicketId && tickets.length > 0) {
      const open = tickets.find(
        (t) => t.status !== "CLOSED" && t.status !== "RESOLVED",
      );
      if (open) setActiveTicketId(open.id);
      else setActiveTicketId(tickets[0]?.id ?? null);
    }
  }, [tickets, activeTicketId]);

  // Fetch ticket detail when active changes
  useEffect(() => {
    if (activeTicketId) void fetchTicketDetail();
  }, [activeTicketId, fetchTicketDetail]);

  // Poll for new messages every 5s
  useEffect(() => {
    if (!activeTicketId) return;
    const interval = setInterval(() => {
      void fetchTicketDetail();
      void fetchTickets();
    }, 5000);
    return () => clearInterval(interval);
  }, [activeTicketId, fetchTicketDetail, fetchTickets]);

  // Scroll to bottom on new messages
  useEffect(() => {
    const count = activeTicket?.messages.length ?? 0;
    if (count > prevMessageCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMessageCount.current = count;
  }, [activeTicket?.messages.length]);

  // Create new ticket
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
      setActiveTicketId(ticket.id);
      setActiveTicket(ticket);
      await fetchTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setCreatingTicket(false);
    }
  }

  // Send message to existing ticket
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
    setActiveTicketId(null);
    setActiveTicket(null);
    setSidebarOpen(false);
  }

  const isClosed =
    activeTicket?.status === "CLOSED" || activeTicket?.status === "RESOLVED";
  const showNewTicketMode =
    !activeTicketId || (!activeTicket && !creatingTicket);

  return (
    <div className={`flex flex-col ${embedMode ? "h-screen" : "min-h-screen"}`}>
      {/* Top badge - only in non-embed */}
      {!embedMode && (
        <div className="flex justify-center pt-4 pb-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-100 rounded-full px-3 py-1">
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ backgroundColor: accent }}
            />
            Поддержка {config.workspaceName}
          </span>
        </div>
      )}

      {/* Card container */}
      <div
        className={`flex-1 flex flex-col ${
          embedMode
            ? ""
            : "mx-auto w-full max-w-[900px] md:my-4 md:rounded-2xl md:shadow-xl md:border overflow-hidden"
        } bg-white`}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-4 py-3 text-white shrink-0"
          style={{ backgroundColor: accent }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded-lg hover:bg-white/20 transition-colors"
            aria-label="Открыть меню"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate">
              {config.chatTitle}
            </div>
            {persona && (
              <div className="text-xs opacity-70">
                {persona.displayName} · {persona.role}
              </div>
            )}
          </div>
          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-white/20 rounded-full px-2 py-0.5">
            <span className="w-1.5 h-1.5 bg-green-300 rounded-full" />
            онлайн
          </span>
        </div>

        {/* Persona block */}
        {persona && showNewTicketMode && (
          <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white text-lg font-bold shrink-0"
              style={{ backgroundColor: accent }}
            >
              {persona.displayName[0]}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{persona.displayName}</div>
              <div className="text-xs text-gray-500">{persona.role}</div>
              {persona.bio && (
                <div className="text-xs text-gray-400 mt-0.5">
                  {persona.bio}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
          {showNewTicketMode ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
                style={{ backgroundColor: `${accent}20` }}
              >
                <Send className="h-6 w-6" style={{ color: accent }} />
              </div>
              <h3 className="text-lg font-semibold text-gray-800 mb-1">
                {tickets.length === 0
                  ? "Начните первый диалог"
                  : "Новый диалог"}
              </h3>
              <p className="text-sm text-gray-500 max-w-xs">
                Задайте ваш вопрос — мы ответим как можно скорее
              </p>
            </div>
          ) : activeTicket ? (
            <>
              {activeTicket.messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} accent={accent} />
              ))}
              {isClosed && (
                <div className="flex justify-center my-4">
                  <div className="bg-gray-100 rounded-full px-4 py-2 text-xs text-gray-500 flex items-center gap-2">
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
          <div className="mx-4 mb-2 flex items-center gap-2 bg-red-50 text-red-600 text-sm rounded-lg px-3 py-2">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Input area */}
        {!isClosed && (
          <div className="shrink-0 border-t bg-white px-4 py-3">
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
                showNewTicketMode ? "Задайте свой вопрос..." : "Ответить..."
              }
              accent={accent}
            />
          </div>
        )}
      </div>

      {/* Sidebar */}
      <TicketsSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        tickets={tickets}
        activeTicketId={activeTicketId}
        onSelect={(id) => {
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

function MessageBubble({ msg, accent }: { msg: ChatMessage; accent: string }) {
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

  return (
    <div
      className={`flex ${isCustomer ? "justify-end" : "justify-start"} mb-2`}
    >
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
          isCustomer
            ? "bg-zinc-900 text-white rounded-br-md"
            : "bg-gray-100 text-gray-800 rounded-bl-md"
        }`}
        style={isCustomer ? { backgroundColor: accent } : undefined}
      >
        {!isCustomer && (
          <div className="text-[11px] font-medium text-gray-500 mb-0.5">
            {msg.authorName}
          </div>
        )}
        <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
          {msg.content}
        </p>
        <div
          className={`text-[10px] mt-1 ${
            isCustomer ? "text-white/50" : "text-gray-400"
          }`}
        >
          {formatDistanceToNow(new Date(msg.createdAt), {
            addSuffix: true,
            locale: ru,
          })}
        </div>
      </div>
    </div>
  );
}
