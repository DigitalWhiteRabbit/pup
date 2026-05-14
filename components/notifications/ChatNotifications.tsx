"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { X, MessageSquare } from "lucide-react";
import { UserAvatar } from "@/components/ui/user-avatar";

type ChatNotif = {
  id: string;
  type: "workspace" | "global";
  author: string;
  hasAvatar: boolean;
  content: string;
  channelId: string;
  channelName: string;
  workspaceName: string;
  workspaceId: string;
  createdAt: string;
};

type Settings = {
  chatSoundEnabled: boolean;
  chatDesktopNotify: boolean;
};

const POLL_INTERVAL = 5000;
const TOAST_DURATION = 6000;
const NOTIFICATION_SOUND_FREQ = 800;

function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.value = NOTIFICATION_SOUND_FREQ;
    osc.type = "sine";
    gain.gain.value = 0.15;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);

    // Second tone
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.frequency.value = 1000;
    osc2.type = "sine";
    gain2.gain.value = 0.12;
    gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc2.start(ctx.currentTime + 0.15);
    osc2.stop(ctx.currentTime + 0.5);
  } catch {
    /* AudioContext not supported */
  }
}

type ToastItem = ChatNotif & { dismissAt: number };

export function ChatNotifications() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const sinceRef = useRef(new Date().toISOString());
  const seenIdsRef = useRef(new Set<string>());
  const settingsRef = useRef<Settings>({
    chatSoundEnabled: true,
    chatDesktopNotify: true,
  });

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Auto-dismiss expired toasts
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => t.dismissAt > now));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Poll for new messages
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/notifications/chat-updates?since=${encodeURIComponent(sinceRef.current)}`,
        );
        if (!res.ok) return;

        const data = (await res.json()) as {
          messages: ChatNotif[];
          settings: Settings | null;
        };

        if (data.settings) settingsRef.current = data.settings;

        const newMsgs = data.messages.filter(
          (m) => !seenIdsRef.current.has(m.id),
        );

        if (newMsgs.length > 0 && settingsRef.current.chatDesktopNotify) {
          const now = Date.now();
          const newToasts: ToastItem[] = newMsgs.map((m) => ({
            ...m,
            dismissAt: now + TOAST_DURATION,
          }));

          setToasts((prev) => [...newToasts, ...prev].slice(0, 5));

          if (settingsRef.current.chatSoundEnabled) {
            playNotificationSound();
          }

          for (const m of newMsgs) {
            seenIdsRef.current.add(m.id);
          }
        }

        // Update since to latest message time
        if (data.messages.length > 0) {
          const latest = data.messages[0]!;
          sinceRef.current = latest.createdAt;
        }
      } catch {
        /* silent */
      }
    };

    const interval = setInterval(() => void poll(), POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-[380px]">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="bg-card border border-border rounded-xl shadow-2xl p-3.5 flex gap-3 animate-in slide-in-from-right-5 fade-in duration-300 cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => {
            dismiss(t.id);
            if (t.type === "global") {
              window.location.href = "/global-chat";
            } else if (t.workspaceId) {
              window.location.href = `/workspaces/${t.workspaceId}/chat${t.channelId ? `?channel=${t.channelId}` : ""}`;
            }
          }}
        >
          {/* Avatar */}
          <div className="shrink-0 mt-0.5">
            <div className="relative">
              <UserAvatar
                userId={t.hasAvatar ? undefined : undefined}
                login={t.author}
                size={36}
              />
              <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center">
                <MessageSquare className="h-2.5 w-2.5 text-white" />
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[13px] font-semibold text-foreground truncate">
                {t.author}
              </span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {t.channelName}
              </span>
            </div>
            <p className="text-[12px] text-muted-foreground line-clamp-2 leading-relaxed">
              {t.content}
            </p>
            {t.workspaceName && (
              <span className="text-[9px] text-muted-foreground/60 mt-0.5 block">
                {t.workspaceName}
              </span>
            )}
          </div>

          {/* Close */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              dismiss(t.id);
            }}
            className="shrink-0 text-muted-foreground/50 hover:text-foreground transition-colors self-start"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
