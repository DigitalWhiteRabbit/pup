import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { QueryProvider } from "@/components/providers/query-provider";
import { SessionProvider } from "@/components/providers/session-provider";
import { AppShell } from "@/components/layout/AppShell";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  return (
    <QueryProvider>
      <SessionProvider session={session}>
        <AppShell
          userLogin={session.user.name ?? session.user.email ?? "user"}
          userRole={session.user.role}
        >
          {children}
        </AppShell>
      </SessionProvider>
    </QueryProvider>
  );
}
