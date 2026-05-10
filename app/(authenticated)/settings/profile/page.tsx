import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { TelegramSettings } from "./telegram-settings";

export default async function ProfileSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      telegramChatId: true,
      tgNotifyAssign: true,
      tgNotifyComment: true,
      tgNotifyMove: true,
      tgNotifyProject: true,
      tgNotifyTaskDeleted: true,
      tgNotifyMemberRemoved: true,
      tgNotifyWorkspaceDeleted: true,
      tgNotifyRoleChanged: true,
    },
  });

  if (!user) redirect("/login");

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-bold">Настройки профиля</h1>
      <TelegramSettings
        connected={!!user.telegramChatId}
        preferences={{
          tgNotifyAssign: user.tgNotifyAssign,
          tgNotifyComment: user.tgNotifyComment,
          tgNotifyMove: user.tgNotifyMove,
          tgNotifyProject: user.tgNotifyProject,
          tgNotifyTaskDeleted: user.tgNotifyTaskDeleted,
          tgNotifyMemberRemoved: user.tgNotifyMemberRemoved,
          tgNotifyWorkspaceDeleted: user.tgNotifyWorkspaceDeleted,
          tgNotifyRoleChanged: user.tgNotifyRoleChanged,
        }}
      />
    </div>
  );
}
