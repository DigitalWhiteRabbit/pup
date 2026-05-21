import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashboardClient } from "./dashboard-client";

export const metadata = { title: "Дашборд | ПУП" };

export default async function DashboardPage() {
  const session = await auth();
  if (!session) redirect("/login");

  return <DashboardClient />;
}
