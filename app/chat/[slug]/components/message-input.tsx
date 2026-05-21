"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";

type Props = {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder: string;
  accent: string;
};

export function MessageInput({ onSend, disabled, placeholder, accent }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 6 * 24; // ~6 rows
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [text]);

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const isEmpty = !text.trim();

  return (
    <div className="flex items-end gap-2.5">
      <div className="flex-1 relative">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="w-full resize-none rounded-xl border border-border bg-muted/50 px-4 py-2.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground transition-all focus:outline-none focus:ring-2 focus:border-transparent focus:bg-background disabled:opacity-40"
          style={
            {
              "--tw-ring-color": `${accent}30`,
            } as React.CSSProperties
          }
          aria-label="Сообщение"
        />
      </div>
      <button
        onClick={handleSubmit}
        disabled={isEmpty || disabled}
        className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-white transition-all duration-200 disabled:opacity-25 hover:shadow-lg"
        style={{
          backgroundColor: accent,
          boxShadow: isEmpty || disabled ? "none" : `0 4px 12px ${accent}30`,
        }}
        aria-label="Отправить"
      >
        {disabled && !isEmpty ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Send className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
