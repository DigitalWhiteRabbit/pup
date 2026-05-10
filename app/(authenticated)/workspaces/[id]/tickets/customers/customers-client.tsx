"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { ArrowLeft, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { CustomerView } from "@/lib/services/tickets/customer.service";

type ListResult = { data: CustomerView[]; total: number };

export function CustomersClient({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const params = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (search) params.set("search", search);

  const { data, isLoading } = useQuery<ListResult>({
    queryKey: ["customers", workspaceId, page, search],
    queryFn: async () => {
      const r = await fetch(
        `/api/workspaces/${workspaceId}/customers?${params.toString()}`,
      );
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/workspaces/${workspaceId}/tickets`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Клиенты</h1>
          <p className="text-sm text-muted-foreground">
            База клиентов workspace
          </p>
        </div>
      </div>

      <form
        className="flex items-center gap-2 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(searchInput.trim());
          setPage(1);
        }}
      >
        <Input
          placeholder="Поиск по email или имени..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="w-64 h-8"
        />
        <Button type="submit" variant="outline" size="sm" className="h-8">
          <Search className="h-3.5 w-3.5" />
        </Button>
      </form>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !data || data.data.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Users className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <p className="text-muted-foreground">Клиентов пока нет</p>
          <p className="text-xs text-muted-foreground mt-1">
            Клиенты появятся когда будут созданы внешние тикеты
          </p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Имя</th>
                <th className="px-3 py-2 font-medium">External ID</th>
                <th className="px-3 py-2 font-medium">Тикетов</th>
                <th className="px-3 py-2 font-medium">Создан</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((c) => (
                <tr
                  key={c.id}
                  className="border-t hover:bg-accent/40 transition-colors"
                >
                  <td className="px-3 py-2.5 font-medium">{c.email}</td>
                  <td className="px-3 py-2.5">{c.name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground font-mono">
                    {c.externalId ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">{c.ticketsCount}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(c.createdAt), {
                      addSuffix: true,
                      locale: ru,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-6">
          <span className="text-sm text-muted-foreground">
            Страница {page} из {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Назад
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
