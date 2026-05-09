import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="flex items-center justify-center h-64 rounded-lg border border-dashed text-muted-foreground text-sm">
        Здесь будет общий дашборд
      </div>
    </div>
  );
}
