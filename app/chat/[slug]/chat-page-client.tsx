"use client";

import { useState, useEffect, useCallback } from "react";
import { IdentityForm } from "./components/identity-form";
import { ChatInterface } from "./components/chat-interface";
import type { ChatConfig, ChatCustomer } from "./types";

type StoredSession = {
  token: string;
  csrf: string;
  customer: ChatCustomer;
};

type Props = {
  slug: string;
  config: ChatConfig;
  embedMode: boolean;
};

export function ChatPageClient({ slug, config, embedMode }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [customer, setCustomer] = useState<ChatCustomer | null>(null);
  const [loading, setLoading] = useState(true);

  const storageKey = `pup_chat_${slug}`;

  // Restore session from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const stored: StoredSession = JSON.parse(raw);
        if (stored.token && stored.customer) {
          setToken(stored.token);
          setCsrf(stored.csrf ?? null);
          setCustomer(stored.customer);
        }
      }
    } catch {
      // corrupted localStorage
    }
    setLoading(false);
  }, [storageKey]);

  const handleIdentified = useCallback(
    (t: string, csrfToken: string, c: ChatCustomer) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ token: t, csrf: csrfToken, customer: c }),
      );
      setToken(t);
      setCsrf(csrfToken);
      setCustomer(c);
    },
    [storageKey],
  );

  const handleLogout = useCallback(() => {
    localStorage.removeItem(storageKey);
    setToken(null);
    setCsrf(null);
    setCustomer(null);
  }, [storageKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!token || !customer) {
    return (
      <IdentityForm
        slug={slug}
        config={config}
        embedMode={embedMode}
        onIdentified={handleIdentified}
      />
    );
  }

  return (
    <ChatInterface
      slug={slug}
      config={config}
      token={token}
      csrf={csrf ?? ""}
      customer={customer}
      embedMode={embedMode}
      onLogout={handleLogout}
    />
  );
}
