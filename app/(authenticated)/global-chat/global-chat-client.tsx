"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { Send, CornerDownRight, X } from "lucide-react";

type Msg = {
  id: string;
  authorId: string;
  authorLogin: string;
  content: string;
  parentId: string | null;
  editedAt: string | null;
  createdAt: string;
  replyTo: { authorLogin: string; content: string } | null;
  reactions: Array<{ emoji: string; count: number; myReaction: boolean }>;
};

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🔥"];

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
  const endRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<{ data: Msg[] }>({
    queryKey: ["global-chat"],
    queryFn: () => fetch("/api/global-chat").then((r) => r.json()),
    refetchInterval: 3000,
  });
  const msgs = data?.data ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  const sendMut = useMutation({
    mutationFn: async (content: string) => {
      const r = await fetch("/api/global-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, parentId: replyTo?.id }),
      });
      if (!r.ok) throw new Error("Ошибка");
      return r.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["global-chat"] });
      setMsgText("");
      setReplyTo(null);
    },
  });

  function send() {
    const t = msgText.trim();
    if (t) sendMut.mutate(t);
  }

  async function react(msgId: string, emoji: string) {
    await fetch(`/api/global-chat/${msgId}/reactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    });
    void qc.invalidateQueries({ queryKey: ["global-chat"] });
  }

  return (
    <div
      className="flex flex-col max-w-3xl mx-auto"
      style={{ height: "100vh", marginTop: "-1px" }}
    >
      {/* header */}
      <div className="px-5 py-4 border-b shrink-0">
        <h1 className="text-lg font-bold text-foreground">💬 Общий чат</h1>
        <p className="text-xs text-gray-400 mt-0.5">
          Гостевой чат для всех пользователей системы
        </p>
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0 bg-muted/30 flex flex-col justify-end">
        {msgs.length === 0 && (
          <div className="flex items-center justify-center flex-1 text-sm text-gray-400">
            Нет сообщений. Начните диалог!
          </div>
        )}
        {msgs.map((m) => {
          const isMe = m.authorId === currentUserId;
          return (
            <div
              key={m.id}
              id={`gmsg-${m.id}`}
              className={`group flex mb-3 transition-colors duration-700 rounded-lg ${isMe ? "justify-end" : "justify-start"} ${highlightMsgId === m.id ? "bg-emerald-100" : ""}`}
            >
              {!isMe && (
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0 mt-0.5 mr-2">
                  {m.authorLogin[0]?.toUpperCase()}
                </div>
              )}
              <div
                className={`max-w-[70%] flex flex-col ${isMe ? "items-end" : "items-start"}`}
              >
                <div
                  className={`flex items-center gap-2 mb-0.5 ${isMe ? "flex-row-reverse" : ""}`}
                >
                  <span className="text-xs font-semibold text-foreground">
                    {m.authorLogin}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {format(new Date(m.createdAt), "HH:mm", { locale: ru })}
                  </span>
                </div>
                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${
                    isMe
                      ? "bg-emerald-500 text-white rounded-br-md"
                      : "bg-card border shadow-sm text-card-foreground rounded-bl-md"
                  }`}
                >
                  {/* reply quote */}
                  {m.replyTo && m.parentId && (
                    <button
                      type="button"
                      className={`mb-1.5 pl-2 border-l-2 text-xs text-left w-full ${isMe ? "border-white/50 hover:bg-white/10" : "border-emerald-400 hover:bg-emerald-50"} rounded transition-colors`}
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
                  {isMe
                    ? m.content
                    : m.content.split(/(@\w+)/g).map((p, i) =>
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
                      )}
                </div>
                {/* reactions */}
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
                {/* hover actions */}
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
        <div className="bg-card border-t px-5 py-1.5 flex items-center gap-2 text-xs text-gray-500 shrink-0">
          <CornerDownRight className="h-3 w-3 text-emerald-500" />
          Ответ: <b>{replyTo.authorLogin}</b>: {replyTo.content.slice(0, 50)}
          <button onClick={() => setReplyTo(null)} className="ml-auto">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* input */}
      <div className="border-t px-5 py-3 shrink-0 bg-card">
        <div className="flex items-end gap-2">
          <div className="flex-1 bg-muted rounded-2xl px-4 py-2.5">
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
              className="w-full bg-transparent text-sm outline-none resize-none min-h-[20px] max-h-[120px] text-foreground"
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
        <div className="text-[10px] text-gray-400 mt-1 pl-1">
          Enter — отправить · Shift+Enter — новая строка
        </div>
      </div>
    </div>
  );
}
