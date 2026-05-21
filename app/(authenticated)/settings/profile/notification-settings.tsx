"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Bell, Volume2 } from "lucide-react";
import { toastSuccess } from "@/lib/toast";

type Props = {
  chatSoundEnabled: boolean;
  chatDesktopNotify: boolean;
};

export function NotificationSettings({
  chatSoundEnabled: initialSound,
  chatDesktopNotify: initialDesktop,
}: Props) {
  const [sound, setSound] = useState(initialSound);
  const [desktop, setDesktop] = useState(initialDesktop);

  async function update(key: string, value: boolean) {
    await fetch("/api/profile/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    toastSuccess("Сохранено");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <Label htmlFor="desktop-notify" className="text-sm cursor-pointer">
            Всплывающие уведомления
          </Label>
        </div>
        <Switch
          id="desktop-notify"
          checked={desktop}
          onCheckedChange={(checked) => {
            setDesktop(checked);
            void update("chatDesktopNotify", checked);
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Volume2 className="h-4 w-4 text-muted-foreground" />
          <Label htmlFor="sound-notify" className="text-sm cursor-pointer">
            Звуковые уведомления
          </Label>
        </div>
        <Switch
          id="sound-notify"
          checked={sound}
          onCheckedChange={(checked) => {
            setSound(checked);
            void update("chatSoundEnabled", checked);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Уведомления появляются в правом нижнем углу при получении новых
        сообщений в чатах.
      </p>
    </div>
  );
}
