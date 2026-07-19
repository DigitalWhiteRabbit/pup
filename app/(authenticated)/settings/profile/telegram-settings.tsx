"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy, Check } from "lucide-react";
import { toastSuccess, toastError } from "@/lib/toast";

type Preferences = {
  tgNotifyAssign: boolean;
  tgNotifyComment: boolean;
  tgNotifyMove: boolean;
  tgNotifyProject: boolean;
  tgNotifyContent: boolean;
  tgNotifyTaskDeleted: boolean;
  tgNotifyMemberRemoved: boolean;
  tgNotifyWorkspaceDeleted: boolean;
  tgNotifyRoleChanged: boolean;
  tgNotifyDeploy: boolean;
  tgNotifyMarketing: boolean;
};

type Props = {
  connected: boolean;
  preferences: Preferences;
  isAdmin: boolean;
};

const PREF_LABELS: Record<keyof Preferences, string> = {
  tgNotifyAssign: "Назначение на задачу",
  tgNotifyComment: "Комментарии к моим задачам",
  tgNotifyMove: "Перемещение моих задач",
  tgNotifyProject: "Добавление в проект",
  tgNotifyContent: "Контент-план: вычитка / правки / одобрено",
  tgNotifyTaskDeleted: "Удаление задачи в workspace",
  tgNotifyMemberRemoved: "Удаление меня из workspace",
  tgNotifyWorkspaceDeleted: "Удаление workspace",
  tgNotifyRoleChanged: "Изменение моей роли",
  tgNotifyDeploy: "Уведомления о деплое",
  tgNotifyMarketing:
    "Маркетинг: письма на проверку, сделки, консультации агента",
};

const PREF_GROUPS: Record<string, Array<keyof Preferences>> = {
  "Уведомления о задачах": [
    "tgNotifyAssign",
    "tgNotifyComment",
    "tgNotifyMove",
    "tgNotifyProject",
  ],
  "Критичные события": [
    "tgNotifyTaskDeleted",
    "tgNotifyMemberRemoved",
    "tgNotifyWorkspaceDeleted",
    "tgNotifyRoleChanged",
  ],
  "Контент-план": ["tgNotifyContent"],
  "Деплой (только для админов)": ["tgNotifyDeploy"],
  Маркетинг: ["tgNotifyMarketing"],
};

export function TelegramSettings({
  connected: initialConnected,
  preferences: initialPrefs,
  isAdmin,
}: Props) {
  const queryClient = useQueryClient();
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [botUsername, setBotUsername] = useState<string>("");
  const [copied, setCopied] = useState(false);

  function copyCommand() {
    if (!generatedCode) return;
    void navigator.clipboard.writeText(`/start ${generatedCode}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Poll connection status when code dialog is open
  const { data: statusData } = useQuery<{ connected: boolean } & Preferences>({
    queryKey: ["telegram-status"],
    queryFn: () => fetch("/api/profile/telegram/status").then((r) => r.json()),
    refetchInterval: codeDialogOpen ? 5000 : false,
  });

  const isConnected = statusData?.connected ?? initialConnected;
  const prefs: Preferences = statusData
    ? {
        tgNotifyAssign: statusData.tgNotifyAssign,
        tgNotifyComment: statusData.tgNotifyComment,
        tgNotifyMove: statusData.tgNotifyMove,
        tgNotifyProject: statusData.tgNotifyProject,
        tgNotifyContent: statusData.tgNotifyContent ?? true,
        tgNotifyTaskDeleted: statusData.tgNotifyTaskDeleted ?? false,
        tgNotifyMemberRemoved: statusData.tgNotifyMemberRemoved ?? false,
        tgNotifyWorkspaceDeleted: statusData.tgNotifyWorkspaceDeleted ?? false,
        tgNotifyRoleChanged: statusData.tgNotifyRoleChanged ?? false,
        tgNotifyDeploy: statusData.tgNotifyDeploy ?? true,
        tgNotifyMarketing: statusData.tgNotifyMarketing ?? false,
      }
    : initialPrefs;

  // Close dialog when connection succeeds
  if (codeDialogOpen && isConnected) {
    setCodeDialogOpen(false);
    setGeneratedCode(null);
    toastSuccess("Telegram подключён");
  }

  const generateCode = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/profile/telegram/generate-code", {
        method: "POST",
      });
      return res.json() as Promise<{
        code: string;
        expiresAt: string;
        botUsername: string;
      }>;
    },
    onSuccess: (data) => {
      setGeneratedCode(data.code);
      setBotUsername(data.botUsername);
      setCodeDialogOpen(true);
    },
    onError: () => {
      toastError("Ошибка генерации кода");
    },
  });

  const disconnect = useMutation({
    mutationFn: () =>
      fetch("/api/profile/telegram/disconnect", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
      toastSuccess("Telegram отключён");
    },
  });

  const updatePref = useMutation({
    mutationFn: (update: Partial<Preferences>) =>
      fetch("/api/profile/telegram/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
      toastSuccess("Сохранено");
    },
  });

  return (
    <>
      <div>
        <div className="space-y-4">
          {!isConnected ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Telegram не подключён. Подключите, чтобы получать уведомления.
              </p>
              <Button
                onClick={() => generateCode.mutate()}
                disabled={generateCode.isPending}
              >
                {generateCode.isPending
                  ? "Генерация..."
                  : "Подключить Telegram"}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-green-600">
                  Telegram подключён
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                >
                  Отключить
                </Button>
              </div>

              <Separator />

              <div className="space-y-5">
                {Object.entries(PREF_GROUPS)
                  .filter(
                    ([groupLabel]) => isAdmin || !groupLabel.includes("Деплой"),
                  )
                  .map(([groupLabel, keys]) => (
                    <div key={groupLabel} className="space-y-3">
                      <p className="text-sm font-medium">{groupLabel}</p>
                      {keys.map((key) => (
                        <div
                          key={key}
                          className="flex items-center justify-between"
                        >
                          <Label htmlFor={key} className="text-sm">
                            {PREF_LABELS[key]}
                          </Label>
                          <Switch
                            id={key}
                            checked={prefs[key]}
                            onCheckedChange={(checked) =>
                              updatePref.mutate({ [key]: checked })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog open={codeDialogOpen} onOpenChange={setCodeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Подключение Telegram</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Перейдите в бота и отправьте команду ниже:
            </p>
            <a
              href={`https://t.me/${botUsername || "controler_panel_bot"}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-md border px-4 py-3 hover:bg-accent transition-colors group"
            >
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">
                  Telegram-бот
                </p>
                <p className="text-sm font-medium">
                  @{botUsername || "controler_panel_bot"}
                </p>
              </div>
              <span className="text-xs text-primary group-hover:underline">
                Открыть →
              </span>
            </a>
            <div className="flex items-center gap-2 rounded-md bg-muted px-4 py-3">
              <code className="flex-1 text-base font-mono font-bold select-all text-center">
                /start {generatedCode}
              </code>
              <button
                onClick={copyCommand}
                className="shrink-0 rounded-md p-1.5 hover:bg-background transition-colors text-muted-foreground hover:text-foreground"
                title="Скопировать"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
            <a
              href={`https://t.me/${botUsername || "controler_panel_bot"}?start=${generatedCode}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full"
            >
              <Button className="w-full">Привязать</Button>
            </a>
            <p className="text-xs text-muted-foreground">
              Код действует 10 минут. После привязки это окно закроется
              автоматически.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
