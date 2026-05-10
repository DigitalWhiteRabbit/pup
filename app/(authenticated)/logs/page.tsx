import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { GlobalLogsClient } from "./global-logs-client";

export default async function GlobalLogsPage() {
  const session = await auth();
  if (!session) redirect("/login");

  return <GlobalLogsClient />;
}
