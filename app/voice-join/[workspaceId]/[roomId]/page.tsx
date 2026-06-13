import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { GuestJoinClient } from "./guest-join-client";
import { verifyVoiceInvite } from "@/lib/services/voice-invite";

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

  // Validate the signed invite token (bound to this workspace+room, unexpired).
  // The API enforces this too; here we show a friendly screen instead of a
  // silent 403 on join.
  if (!verifyVoiceInvite(token, workspaceId, roomId)) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 w-full max-w-[380px] text-center">
          <h2 className="text-xl font-bold text-white mb-2">
            Ссылка недействительна
          </h2>
          <p className="text-sm text-gray-500">
            Приглашение в голосовой канал просрочено или некорректно. Попросите
            участника прислать новую ссылку.
          </p>
        </div>
      </div>
    );
  }

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
