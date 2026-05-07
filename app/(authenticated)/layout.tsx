import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { QueryProvider } from "@/components/providers/query-provider";
import { SessionProvider } from "@/components/providers/session-provider";
import { Sidebar } from "@/components/layout/Sidebar";

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
        <div className="flex h-screen overflow-hidden">
          <Sidebar
            userLogin={session.user.name ?? session.user.email ?? "user"}
            userRole={session.user.role}
          />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </SessionProvider>
    </QueryProvider>
  );
}
