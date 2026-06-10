"use client";

import { Shield } from "lucide-react";
import { ContentCard } from "./ContentCard";
import type { ContentCardView } from "@/lib/content/types";

export function Moderation({ cards }: { cards: ContentCardView[] }) {
  const queue = cards.filter((c) => c.status === "REVIEW");

  return (
    <div>
      <div className="mb-4 flex items-center gap-2.5 rounded-xl border bg-card px-3.5 py-3 text-xs text-muted-foreground">
        <Shield className="h-4 w-4 shrink-0 text-emerald-500" />
        Режим старшего менеджера. Очередь карточек «На вычитке» — оставь
        админ-комментарий и реши: вернуть на правки или одобрить.
      </div>
      {queue.length === 0 ? (
        <div className="rounded-xl border bg-card p-14 text-center text-[13.5px] text-muted-foreground">
          Очередь пуста — нет карточек на вычитке.
        </div>
      ) : (
        queue.map((c) => <ContentCard key={c.id} card={c} modMode />)
      )}
    </div>
  );
}
