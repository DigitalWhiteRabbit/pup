import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { GuestJoinClient } from "./guest-join-client";

type Props = {
  params: Promise<{ workspaceId: string; roomId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function VoiceJoinPage({ params, searchParams }: Props) {
  const { workspaceId, roomId } = await params;
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";

  const room = await db.voiceRoom.findUnique({
    where: { id: roomId },
    include: { workspace: { select: { name: true, logoPath: true } } },
  });

  if (!room || room.workspaceId !== workspaceId) notFound();

  return (
    <GuestJoinClient
      workspaceId={workspaceId}
      roomId={roomId}
      roomName={room.name}
      workspaceName={room.workspace.name}
      hasLogo={!!room.workspace.logoPath}
      token={token}
    />
  );
}
