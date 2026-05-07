import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { UsersClient } from "./users-client";

export const metadata = { title: "Управление пользователями — CRM" };

export default async function AdminUsersPage() {
  const session = await auth();

  if (!session || session.user.role !== "ADMIN") {
    redirect("/projects");
  }

  return <UsersClient />;
}
