"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Mail, Server, Shield, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toastSuccess, toastApiError } from "@/lib/toast";

type EmailConfig = {
  id: string;
  enabled: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpSecure: boolean;
  fromEmail: string | null;
  fromName: string | null;
  inboundSecret: string | null;
};

export function EmailSettingsClient({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery<{ config: EmailConfig | null }>({
    queryKey: ["email-config", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/email/config`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const cfg = data?.config;

  const [enabled, setEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");

  useEffect(() => {
    if (cfg) {
      setEnabled(cfg.enabled);
      setSmtpHost(cfg.smtpHost ?? "");
      setSmtpPort(String(cfg.smtpPort ?? 587));
      setSmtpUser(cfg.smtpUser ?? "");
      setSmtpSecure(cfg.smtpSecure);
      setFromEmail(cfg.fromEmail ?? "");
      setFromName(cfg.fromName ?? "");
    }
  }, [cfg]);

  const saveMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetch(`/api/workspaces/${workspaceId}/email/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).error ?? "Ошибка");
        return r.json();
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["email-config", workspaceId] });
      toastSuccess("Настройки сохранены");
    },
    onError: toastApiError,
  });

  const webhookUrl = cfg?.inboundSecret
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/email/inbound/${workspaceId}`
    : "";

  function handleCopy(text: string) {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/workspaces/${workspaceId}/tickets`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold">Настройки Email</h1>
          <p className="text-sm text-muted-foreground">
            Приём и отправка тикетов через email
          </p>
        </div>
      </div>

      {/* Enable toggle */}
      <div className="border rounded-xl p-4 mb-6">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              saveMut.mutate({ enabled: e.target.checked });
            }}
            className="w-4 h-4"
          />
          <div>
            <div className="text-sm font-medium">
              <Mail className="h-4 w-4 inline mr-1.5" />
              Email канал активен
            </div>
            <div className="text-xs text-muted-foreground">
              Входящие email создают тикеты, ответы менеджеров отправляются по
              email
            </div>
          </div>
        </label>
      </div>

      {/* SMTP */}
      <div className="border rounded-xl p-5 mb-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">SMTP (исходящая почта)</h2>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium mb-1 block">SMTP Host</label>
            <Input
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="smtp.gmail.com"
            />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Порт</label>
            <Input
              value={smtpPort}
              onChange={(e) => setSmtpPort(e.target.value)}
              placeholder="587"
            />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Логин</label>
            <Input
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              placeholder="user@gmail.com"
            />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Пароль</label>
            <Input
              type="password"
              value={smtpPass}
              onChange={(e) => setSmtpPass(e.target.value)}
              placeholder="app password"
            />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">
              Email отправителя
            </label>
            <Input
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="support@company.com"
            />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">
              Имя отправителя
            </label>
            <Input
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Поддержка"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={smtpSecure}
            onChange={(e) => setSmtpSecure(e.target.checked)}
          />
          SSL/TLS (порт 465)
        </label>

        <Button
          size="sm"
          onClick={() =>
            saveMut.mutate({
              smtpHost: smtpHost || null,
              smtpPort: smtpPort ? parseInt(smtpPort, 10) : null,
              smtpUser: smtpUser || null,
              smtpPass: smtpPass || null,
              smtpSecure,
              fromEmail: fromEmail || null,
              fromName: fromName || null,
            })
          }
          disabled={saveMut.isPending}
        >
          {saveMut.isPending ? "Сохранение..." : "Сохранить SMTP"}
        </Button>
      </div>

      {/* Inbound webhook */}
      <div className="border rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Входящая почта (Webhook)</h2>
        </div>

        <p className="text-xs text-muted-foreground">
          Настройте пересылку входящих писем на этот webhook. Поддерживается
          SendGrid Inbound Parse, Mailgun Routes, или свой скрипт.
        </p>

        {webhookUrl && (
          <>
            <div>
              <label className="text-xs font-medium mb-1 block">
                Webhook URL
              </label>
              <div className="flex gap-2">
                <Input
                  value={webhookUrl}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => handleCopy(webhookUrl)}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block">
                Секретный ключ
              </label>
              <Input
                value={cfg?.inboundSecret ?? ""}
                readOnly
                className="font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Передавайте в поле &quot;secret&quot; в теле запроса
              </p>
            </div>

            <div className="bg-muted rounded-lg p-3">
              <div className="text-xs font-medium mb-1">Формат запроса:</div>
              <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap">
                {`POST ${webhookUrl}
Content-Type: application/json

{
  "from": "client@example.com",
  "fromName": "Иван",
  "subject": "Вопрос по заказу",
  "textBody": "Здравствуйте...",
  "secret": "${cfg?.inboundSecret ?? "..."}"
}`}
              </pre>
            </div>
          </>
        )}

        {!cfg && (
          <p className="text-xs text-muted-foreground">
            Сохраните SMTP настройки, чтобы получить webhook URL и секрет.
          </p>
        )}
      </div>
    </div>
  );
}
