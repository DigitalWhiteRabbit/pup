import { notFound } from "next/navigation";
import { ChatPageClient } from "./chat-page-client";
import type { ChatConfig } from "./types";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function fetchConfig(slug: string): Promise<ChatConfig | null> {
  // Use absolute URL for server-side fetch during SSR
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/chat/${slug}/config`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json() as Promise<ChatConfig>;
  } catch {
    return null;
  }
}

export default async function ChatPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const config = await fetchConfig(slug);
  if (!config) notFound();

  return (
    <ChatPageClient slug={slug} config={config} embedMode={sp.embed === "1"} />
  );
}
