"use client";

import { useState } from "react";
import Image from "next/image";
import { Loader2, MessageCircle } from "lucide-react";
import type { ChatConfig, ChatCustomer } from "../types";

type Props = {
  slug: string;
  config: ChatConfig;
  embedMode: boolean;
  onIdentified: (token: string, csrf: string, customer: ChatCustomer) => void;
};

export function IdentityForm({ slug, config, embedMode, onIdentified }: Props) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const method = config.identityMethod;
  const accent = config.chatAccentColor || "#22c55e";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const body: Record<string, string> = { method };
      if (method === "EMAIL_WITH_NAME" || method === "EMAIL_ONLY") {
        body.email = email.trim();
        if (method === "EMAIL_WITH_NAME" && name.trim()) {
          body.name = name.trim();
        }
      }

      const res = await fetch(`/api/chat/${slug}/identify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error || "Ошибка идентификации",
        );
      }

      const data = (await res.json()) as {
        token: string;
        csrf: string;
        customer: ChatCustomer;
      };
      onIdentified(data.token, data.csrf, data.customer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  const persona = config.activePersona;

  return (
    <div
      className={`flex items-center justify-center ${embedMode ? "min-h-screen" : "min-h-screen px-4 py-8"}`}
    >
      <div className="w-full max-w-md">
        {/* Header card */}
        <div
          className="rounded-t-2xl p-6 text-white"
          style={{ backgroundColor: accent }}
        >
          {config.chatLogoUrl && (
            <Image
              src={config.chatLogoUrl}
              alt=""
              width={120}
              height={40}
              className="h-10 w-auto mb-3 rounded"
              unoptimized
            />
          )}
          <h1 className="text-2xl font-bold">{config.chatTitle}</h1>
          <p className="text-sm opacity-80 mt-1">{config.chatSubtitle}</p>
          {persona && (
            <div className="flex items-center gap-3 mt-4 pt-3 border-t border-white/20">
              <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center text-lg font-bold">
                {persona.displayName[0]}
              </div>
              <div>
                <div className="text-sm font-medium">{persona.displayName}</div>
                <div className="text-xs opacity-70">{persona.role}</div>
              </div>
            </div>
          )}
        </div>

        {/* Form */}
        <div className="bg-white rounded-b-2xl p-6 shadow-lg border border-t-0">
          <form onSubmit={handleSubmit} className="space-y-4">
            {method === "ANONYMOUS" ? (
              <p className="text-sm text-gray-500 text-center">
                Нажмите кнопку ниже, чтобы начать диалог
              </p>
            ) : method === "EMAIL_WITH_NAME" ? (
              <>
                <div>
                  <label
                    htmlFor="chat-name"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Ваше имя
                  </label>
                  <input
                    id="chat-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Иван"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
                    maxLength={200}
                  />
                </div>
                <div>
                  <label
                    htmlFor="chat-email"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Email
                  </label>
                  <input
                    id="chat-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="ivan@example.com"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
                  />
                </div>
              </>
            ) : method === "EMAIL_ONLY" ? (
              <div>
                <label
                  htmlFor="chat-email"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Email
                </label>
                <input
                  id="chat-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="ivan@example.com"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
                />
              </div>
            ) : null}

            {error && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={
                loading ||
                ((method === "EMAIL_WITH_NAME" || method === "EMAIL_ONLY") &&
                  !email.trim())
              }
              className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-opacity disabled:opacity-50"
              style={{ backgroundColor: accent }}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MessageCircle className="h-4 w-4" />
              )}
              {loading ? "Подключение..." : "Начать диалог"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
