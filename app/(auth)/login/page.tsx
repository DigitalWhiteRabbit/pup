"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@/lib/schemas/user.schema";
import { toastError } from "@/lib/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
  });

  async function onSubmit(data: LoginInput) {
    setIsLoading(true);
    try {
      // Get CSRF token first
      const csrfRes = await fetch("/api/auth/csrf");
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

      // POST credentials directly — same as what signIn() does internally
      const body = new URLSearchParams({
        loginOrEmail: data.loginOrEmail,
        password: data.password,
        csrfToken,
        redirect: "false",
        callbackUrl: "/projects",
        json: "true",
      });

      const res = await fetch("/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        redirect: "follow",
      });

      // Success: server redirects to callbackUrl (or /api/auth/error on failure)
      if (
        res.ok &&
        !res.url.includes("/api/auth/error") &&
        !res.url.includes("error=")
      ) {
        router.push("/projects");
        router.refresh();
      } else {
        toastError(
          "Неверный логин или пароль. Проверьте данные и попробуйте снова.",
        );
      }
    } catch {
      toastError("Не удалось подключиться к серверу. Попробуйте позже.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Вход в CRM</CardTitle>
          <CardDescription>Введите логин или email и пароль</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="loginOrEmail">Логин или Email</Label>
              <Input
                id="loginOrEmail"
                placeholder="admin или admin@example.com"
                autoComplete="username"
                aria-invalid={!!errors.loginOrEmail}
                {...register("loginOrEmail")}
              />
              {errors.loginOrEmail && (
                <p className="text-sm text-destructive">
                  {errors.loginOrEmail.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="password">Пароль</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!errors.password}
                {...register("password")}
              />
              {errors.password && (
                <p className="text-sm text-destructive">
                  {errors.password.message}
                </p>
              )}
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? "Вход..." : "Войти"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
