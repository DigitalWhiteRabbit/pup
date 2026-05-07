import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { QueryProvider } from "@/components/providers/query-provider";
import { SessionProvider } from "@/components/providers/session-provider";

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
      <SessionProvider session={session}>{children}</SessionProvider>
    </QueryProvider>
  );
}
