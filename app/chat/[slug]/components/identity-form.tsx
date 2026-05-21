"use client";

import { useState } from "react";
import Image from "next/image";
import { Loader2, ArrowRight } from "lucide-react";
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
      style={{
        background: `linear-gradient(135deg, ${accent}08 0%, ${accent}03 50%, transparent 100%)`,
      }}
    >
      <div className="w-full max-w-[400px] animate-in fade-in slide-in-from-bottom-4 duration-500">
        {/* Card */}
        <div className="rounded-2xl border border-border bg-card shadow-xl shadow-black/5 overflow-hidden">
          {/* Accent header strip */}
          <div
            className="px-6 pt-6 pb-5"
            style={{
              background: `linear-gradient(180deg, ${accent}12 0%, transparent 100%)`,
            }}
          >
            {config.chatLogoUrl && (
              <Image
                src={config.chatLogoUrl}
                alt=""
                width={120}
                height={40}
                className="h-9 w-auto mb-4 rounded"
                unoptimized
              />
            )}
            <h1 className="text-xl font-bold text-foreground">
              {config.chatTitle}
            </h1>
            {config.chatSubtitle && (
              <p className="text-sm text-muted-foreground mt-1">
                {config.chatSubtitle}
              </p>
            )}

            {/* Persona card */}
            {persona && (
              <div className="flex items-center gap-3 mt-5 p-3 rounded-xl bg-card/80 backdrop-blur-sm border border-border shadow-sm">
                {persona.avatarUrl ? (
                  <Image
                    src={`/api/chat/avatars/${persona.avatarUrl.replace(/^personas\//, "")}`}
                    alt={persona.displayName}
                    width={40}
                    height={40}
                    className="w-10 h-10 rounded-full object-cover shrink-0 ring-2 ring-background"
                    unoptimized
                  />
                ) : (
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white text-base font-bold shrink-0"
                    style={{ backgroundColor: accent }}
                  >
                    {persona.displayName[0]}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    {persona.displayName}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span className="text-xs text-muted-foreground">
                      {persona.role}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Form */}
          <div className="px-6 pb-6">
            <form onSubmit={handleSubmit} className="space-y-3.5">
              {method === "ANONYMOUS" ? (
                <p className="text-sm text-muted-foreground text-center py-2">
                  Нажмите кнопку ниже, чтобы начать диалог
                </p>
              ) : method === "EMAIL_WITH_NAME" ? (
                <>
                  <div>
                    <label
                      htmlFor="chat-name"
                      className="block text-xs font-medium text-muted-foreground mb-1.5"
                    >
                      Ваше имя
                    </label>
                    <input
                      id="chat-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Иван"
                      className="w-full rounded-xl border border-border bg-muted/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-all focus:outline-none focus:ring-2 focus:border-transparent"
                      style={
                        {
                          "--tw-ring-color": `${accent}40`,
                        } as React.CSSProperties
                      }
                      maxLength={200}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="chat-email"
                      className="block text-xs font-medium text-muted-foreground mb-1.5"
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
                      className="w-full rounded-xl border border-border bg-muted/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-all focus:outline-none focus:ring-2 focus:border-transparent"
                      style={
                        {
                          "--tw-ring-color": `${accent}40`,
                        } as React.CSSProperties
                      }
                    />
                  </div>
                </>
              ) : method === "EMAIL_ONLY" ? (
                <div>
                  <label
                    htmlFor="chat-email"
                    className="block text-xs font-medium text-muted-foreground mb-1.5"
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
                    className="w-full rounded-xl border border-border bg-muted/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-all focus:outline-none focus:ring-2 focus:border-transparent"
                    style={
                      {
                        "--tw-ring-color": `${accent}40`,
                      } as React.CSSProperties
                    }
                  />
                </div>
              ) : null}

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-xl px-4 py-2.5 border border-red-100">
                  <span className="shrink-0 text-base">!</span>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={
                  loading ||
                  ((method === "EMAIL_WITH_NAME" || method === "EMAIL_ONLY") &&
                    !email.trim())
                }
                className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:opacity-90 hover:shadow-lg disabled:opacity-40 disabled:shadow-none"
                style={{
                  backgroundColor: accent,
                  boxShadow: loading ? "none" : `0 4px 14px ${accent}30`,
                }}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    Начать диалог
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* Powered by */}
        <div className="text-center mt-4">
          <span className="text-xs text-muted-foreground">
            {config.workspaceName}
          </span>
        </div>
      </div>
    </div>
  );
}
