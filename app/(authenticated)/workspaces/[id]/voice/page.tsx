import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { VoiceChannelClient } from "./voice-channel-client";

export const metadata = { title: "Голос | ПУП" };

type Props = { params: { id: string } };

export default async function VoicePage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="h-full min-h-0 flex flex-col">
      <VoiceChannelClient
        workspaceId={params.id}
        currentUserId={session.user.id}
        currentUserLogin={(session.user as unknown as { login: string }).login}
      />
    </div>
  );
}
