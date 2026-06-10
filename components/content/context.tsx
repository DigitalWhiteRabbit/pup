"use client";

import { createContext, useContext } from "react";
import type { CardAction, ContentCardView } from "@/lib/content/types";
import type { CardStatus } from "@/lib/content/constants";

export type LightboxContent =
  | { kind: "image"; src: string }
  | { kind: "iframe"; src: string }
  | { kind: "video"; src: string };

export type ContentMember = { id: string; login: string };

export type ContentContextValue = {
  workspaceId: string;
  isModerator: boolean;
  currentUserId: string;
  members: ContentMember[];

  expanded: Set<string>;
  toggleExpand: (id: string) => void;

  openCreate: () => void;
  openEdit: (card: ContentCardView) => void;
  openLightbox: (content: LightboxContent) => void;

  doAction: (
    cardId: string,
    action: CardAction,
    publishedUrl?: string,
  ) => Promise<void>;
  doDuplicate: (cardId: string) => Promise<void>;
  doShiftDate: (cardId: string, delta: number) => Promise<void>;
  doDelete: (cardId: string, title: string) => Promise<void>;
  doSetStatus: (cardId: string, status: CardStatus) => Promise<void>;
  doSetAdminComment: (cardId: string, value: string) => Promise<void>;
};

export const ContentContext = createContext<ContentContextValue | null>(null);

export function useContent(): ContentContextValue {
  const ctx = useContext(ContentContext);
  if (!ctx) throw new Error("useContent must be used within ContentContext");
  return ctx;
}
