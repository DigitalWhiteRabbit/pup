"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

type OnlineUser = { id: string; login: string };

export function OnlineUsers() {
  useEffect(() => {
    async function ping() {
      await fetch("/api/users/heartbeat", { method: "POST" });
    }
    void ping();
    const id = setInterval(ping, 60_000);
    return () => clearInterval(id);
  }, []);

  const { data: users = [] } = useQuery<OnlineUser[]>({
    queryKey: ["users", "online"],
    queryFn: async () => {
      const res = await fetch("/api/users/online");
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  if (users.length === 0) return null;

  return (
    <div className="mx-3 mb-2 rounded-lg border px-3 py-2">
      <p className="text-xs uppercase tracking-wider mb-1.5 text-emerald-500">
        Онлайн
      </p>
      <div className="flex flex-col gap-1">
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
            <span className="text-xs text-muted-foreground truncate">
              {u.login}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
