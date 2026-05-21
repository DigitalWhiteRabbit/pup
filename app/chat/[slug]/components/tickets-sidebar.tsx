"use client";

import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { X, Plus, LogOut, MessageSquare } from "lucide-react";
import { STATUS_BADGE_COLORS, STATUS_LABELS } from "@/lib/constants/ui";
import type { ChatTicketSummary } from "../types";

type Props = {
  open: boolean;
  onClose: () => void;
  tickets: ChatTicketSummary[];
  activeTicketId: string | null;
  onSelect: (id: string) => void;
  onNewDialog: () => void;
  onLogout: () => void;
  accent: string;
  customerName: string;
};

export function TicketsSidebar({
  open,
  onClose,
  tickets,
  activeTicketId,
  onSelect,
  onNewDialog,
  onLogout,
  accent,
  customerName,
}: Props) {
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div className="fixed inset-y-0 left-0 w-full max-w-xs bg-card shadow-xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="text-sm font-semibold text-foreground">
            Мои диалоги
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted"
            aria-label="Закрыть меню"
          >
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>

        {/* Customer info */}
        <div className="px-4 py-2 bg-muted border-b text-xs text-muted-foreground">
          {customerName}
        </div>

        {/* Tickets list */}
        <div className="flex-1 overflow-y-auto">
          {tickets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <MessageSquare className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">Нет диалогов</p>
            </div>
          ) : (
            <div className="divide-y">
              {tickets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onSelect(t.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-muted transition-colors ${
                    t.id === activeTicketId
                      ? "bg-emerald-50 dark:bg-emerald-900/20"
                      : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        #{t.number} {t.title}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {t.messagesCount} сообщ. ·{" "}
                        {formatDistanceToNow(new Date(t.lastMessageAt), {
                          addSuffix: true,
                          locale: ru,
                        })}
                      </div>
                    </div>
                    <span
                      className={`text-xs font-medium px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_BADGE_COLORS[t.status] ?? "bg-gray-100 text-gray-500"}`}
                    >
                      {STATUS_LABELS[t.status] ?? t.status}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t p-3 space-y-2">
          <button
            onClick={onNewDialog}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white transition-opacity"
            style={{ backgroundColor: accent }}
          >
            <Plus className="h-4 w-4" />
            Новый диалог
          </button>
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            Выйти
          </button>
        </div>
      </div>
    </>
  );
}
