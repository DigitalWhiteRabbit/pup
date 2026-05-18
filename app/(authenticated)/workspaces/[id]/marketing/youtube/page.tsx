import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { YouTubeParserClient } from "./youtube-parser-client";

type Props = { params: { id: string } };

export default async function YouTubeParserPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const on = await isModuleEnabled(
    params.id,
    "marketing",
    session.user.id,
    session.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);

  return <YouTubeParserClient workspaceId={params.id} />;
}
