import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { TelegramSettings } from "./telegram-settings";
import { ChangePassword } from "./change-password";
import { AvatarUpload } from "./avatar-upload";
import { NotificationSettings } from "./notification-settings";

function SectionColumns({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="animate-in fade-in grid grid-cols-1 gap-x-10 gap-y-4 py-8 duration-500 md:grid-cols-10">
      <div className="w-full space-y-1.5 md:col-span-4">
        <h2 className="text-lg leading-none font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm text-balance">
          {description}
        </p>
      </div>
      <div className={cn("md:col-span-6", className)}>{children}</div>
    </div>
  );
}

export default async function ProfileSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      login: true,
      email: true,
      role: true,
      avatarPath: true,
      createdAt: true,
      telegramChatId: true,
      tgNotifyAssign: true,
      tgNotifyComment: true,
      tgNotifyMove: true,
      tgNotifyProject: true,
      tgNotifyContent: true,
      tgNotifyTaskDeleted: true,
      tgNotifyMemberRemoved: true,
      tgNotifyWorkspaceDeleted: true,
      tgNotifyRoleChanged: true,
      tgNotifyDeploy: true,
      tgNotifyMarketing: true,
      chatSoundEnabled: true,
      chatDesktopNotify: true,
    },
  });

  if (!user) redirect("/login");

  return (
    <section className="relative min-h-screen w-full px-4 py-10">
      {/* Subtle radial gradient background */}
      <div
        aria-hidden
        className="absolute inset-0 isolate -z-10 opacity-65 contain-strict"
      >
        <div className="bg-[radial-gradient(68.54%_68.72%_at_55.02%_31.46%,var(--tw-color-foreground,rgb(0,0,0))_0%,hsla(0,0%,55%,.02)_50%,var(--tw-color-foreground,rgb(0,0,0))_80%)] absolute top-0 left-0 h-[80rem] w-[35rem] -translate-y-[22rem] -rotate-45 rounded-full opacity-[0.06]" />
        <div className="bg-[radial-gradient(50%_50%_at_50%_50%,var(--tw-color-foreground,rgb(0,0,0))_0%,var(--tw-color-foreground,rgb(0,0,0))_80%,transparent_100%)] absolute top-0 left-0 h-[80rem] w-[15rem] translate-x-[5%] -translate-y-1/2 -rotate-45 rounded-full opacity-[0.04]" />
      </div>

      <div className="mx-auto w-full max-w-4xl space-y-2">
        {/* Header */}
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-foreground">
            Настройки профиля
          </h1>
          <p className="text-muted-foreground text-base">
            Управление аккаунтом и личной информацией.
          </p>
        </div>

        <Separator />

        {/* Avatar Section */}
        <SectionColumns
          title="Ваш аватар"
          description="Аватар помогает коллегам узнать вас в чате и задачах."
        >
          <div className="flex items-center gap-5">
            <AvatarUpload
              userId={user.id}
              login={user.login}
              hasAvatar={!!user.avatarPath}
            />
            <div className="min-w-0">
              <p className="text-xl font-bold text-foreground leading-tight">
                {user.login}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {user.email}
              </p>
              <div className="flex items-center gap-2.5 mt-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/15 text-emerald-500">
                  {user.role === "ADMIN" ? "Администратор" : "Пользователь"}
                </span>
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-muted text-muted-foreground">
                  С{" "}
                  {user.createdAt.toLocaleDateString("ru-RU", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              </div>
            </div>
          </div>
        </SectionColumns>

        <Separator />

        {/* Password Section */}
        <SectionColumns
          title="Смена пароля"
          description="Для безопасности используйте надёжный пароль длиной не менее 6 символов."
        >
          <ChangePassword />
        </SectionColumns>

        <Separator />

        {/* Telegram Section */}
        <SectionColumns
          title="Telegram"
          description="Подключите Telegram-бота для получения уведомлений о задачах и событиях."
        >
          <TelegramSettings
            connected={!!user.telegramChatId}
            isAdmin={user.role === "ADMIN"}
            preferences={{
              tgNotifyAssign: user.tgNotifyAssign,
              tgNotifyComment: user.tgNotifyComment,
              tgNotifyMove: user.tgNotifyMove,
              tgNotifyProject: user.tgNotifyProject,
              tgNotifyContent: user.tgNotifyContent,
              tgNotifyTaskDeleted: user.tgNotifyTaskDeleted,
              tgNotifyMemberRemoved: user.tgNotifyMemberRemoved,
              tgNotifyWorkspaceDeleted: user.tgNotifyWorkspaceDeleted,
              tgNotifyRoleChanged: user.tgNotifyRoleChanged,
              tgNotifyDeploy: user.tgNotifyDeploy,
              tgNotifyMarketing: user.tgNotifyMarketing,
            }}
          />
        </SectionColumns>

        <Separator />

        {/* Notification Settings */}
        <SectionColumns
          title="Уведомления в чатах"
          description="Настройте всплывающие и звуковые уведомления о новых сообщениях."
        >
          <NotificationSettings
            chatSoundEnabled={user.chatSoundEnabled}
            chatDesktopNotify={user.chatDesktopNotify}
          />
        </SectionColumns>
      </div>
    </section>
  );
}
