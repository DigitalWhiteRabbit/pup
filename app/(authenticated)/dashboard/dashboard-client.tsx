"use client";

import Link from "next/link";

export function DashboardClient() {
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="flex items-center justify-center h-64 rounded-lg border border-dashed text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <p>Здесь будет общий дашборд</p>
          <Link
            href="/workspaces"
            className="text-xs text-primary hover:underline"
          >
            Перейти к проектам →
          </Link>
        </div>
      </div>
    </div>
  );
}
