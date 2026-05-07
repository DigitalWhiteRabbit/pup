import { auth } from "@/lib/auth";
import { getProjectsForUser } from "@/lib/services/project.service";
import { ProjectsClient } from "./projects-client";

export default async function ProjectsPage() {
  const session = await auth();
  // session is guaranteed by the authenticated layout
  const initialData = await getProjectsForUser(
    session!.user.id,
    session!.user.role,
    1,
    20,
  );

  return <ProjectsClient initialData={initialData} />;
}
