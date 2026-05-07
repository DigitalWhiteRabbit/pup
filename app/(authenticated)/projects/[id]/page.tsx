import { auth } from "@/lib/auth";
import { getProjectById } from "@/lib/services/project.service";
import { redirect } from "next/navigation";
import { ProjectBoardShell } from "./project-board-shell";

type Props = { params: { id: string } };

export default async function ProjectPage({ params }: Props) {
  const session = await auth();

  let project;
  try {
    project = await getProjectById(
      params.id,
      session!.user.id,
      session!.user.role,
    );
  } catch {
    redirect("/projects");
  }

  return (
    <ProjectBoardShell
      project={project}
      currentUserId={session!.user.id}
      currentUserRole={session!.user.role}
    />
  );
}
