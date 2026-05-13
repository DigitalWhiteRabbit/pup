"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { Send } from "lucide-react";

type Msg = {
  id: string;
  authorId: string;
  authorLogin: string;
  content: string;
  editedAt: string | null;
  createdAt: string;
};

export function GlobalChatClient({
  currentUserId,
  currentUserLogin: _login,
}: {
  currentUserId: string;
  currentUserLogin: string;
}) {
  const qc = useQueryClient();
  const [msgText, setMsgText] = useState("");
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
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error("Ошибка");
      return r.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["global-chat"] });
      setMsgText("");
    },
  });

  function send() {
    const t = msgText.trim();
    if (t) sendMut.mutate(t);
  }

  return (
    <div
      className="flex flex-col max-w-3xl mx-auto"
      style={{ height: "100vh", marginTop: "-1px" }}
    >
      {/* header */}
      <div className="px-5 py-4 border-b shrink-0">
        <h1 className="text-lg font-bold text-gray-800">💬 Общий чат</h1>
        <p className="text-xs text-gray-400 mt-0.5">
          Гостевой чат для всех пользователей системы
        </p>
      </div>

      {/* messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0 bg-gray-50 flex flex-col justify-end">
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
              className={`flex mb-3 ${isMe ? "justify-end" : "justify-start"}`}
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
                    {format(new Date(m.createdAt), "HH:mm", { locale: ru })}
                  </span>
                </div>
                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${
                    isMe
                      ? "bg-emerald-500 text-white rounded-br-md"
                      : "bg-white border shadow-sm text-gray-700 rounded-bl-md"
                  }`}
                >
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

      {/* input */}
      <div className="border-t px-5 py-3 shrink-0 bg-white">
        <div className="flex items-end gap-2">
          <div className="flex-1 bg-gray-100 rounded-2xl px-4 py-2.5">
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
        <div className="text-[10px] text-gray-400 mt-1 pl-1">
          Enter — отправить · Shift+Enter — новая строка
        </div>
      </div>
    </div>
  );
}
