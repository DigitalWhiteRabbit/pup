"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastSuccess } from "@/lib/toast";

export function ChangePassword() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }
    if (newPassword.length < 6) {
      setError("Минимум 6 символов");
      return;
    }

    setLoading(true);
    try {
      const r = await fetch("/api/profile/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? "Ошибка");
        return;
      }
      toastSuccess("Пароль изменён");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-5">
      <h2 className="text-lg font-semibold text-foreground mb-4">
        Изменить пароль
      </h2>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="space-y-3 max-w-sm"
      >
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Текущий пароль
          </label>
          <Input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Новый пароль
          </label>
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Минимум 6 символов"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Подтвердите новый пароль
          </label>
          <Input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Повторите пароль"
          />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <Button
          type="submit"
          disabled={
            loading || !currentPassword || !newPassword || !confirmPassword
          }
          className="w-full"
        >
          {loading ? "Сохранение..." : "Изменить пароль"}
        </Button>
      </form>
    </div>
  );
}
