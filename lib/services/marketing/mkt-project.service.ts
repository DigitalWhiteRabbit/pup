"use server";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from "@/lib/db";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface CreateProjectData {
  name: string;
  description: string;
  targetAudience?: string;
  budgetMin?: number;
  budgetMax?: number;
  adFormats?: string[];
  language?: string;
  agentPersona?: string;
  idealChannelProfile?: string;
  badFitExamples?: string;
  valueProp?: string;
  toneOfVoice?: string;
  stopWords?: string[];
}

type UpdateProjectData = Partial<CreateProjectData>;

// ═══════════════════════════════════════════════════════════════════════════
// List Projects
// ═══════════════════════════════════════════════════════════════════════════

export async function listProjects(workspaceId: string) {
  return db.mktProject.findMany({
    where: { workspaceId },
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
    include: {
      _count: { select: { leads: true, deals: true } },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Get Single Project
// ═══════════════════════════════════════════════════════════════════════════

export async function getProject(workspaceId: string, projectId: string) {
  const project = await db.mktProject.findFirst({
    where: { id: projectId, workspaceId },
    include: {
      _count: { select: { leads: true, deals: true } },
      leads: {
        orderBy: { leadScore: "desc" },
        take: 20,
        select: {
          id: true,
          channelName: true,
          leadStatus: true,
          dialogueStage: true,
          leadScore: true,
          subscribers: true,
          email: true,
        },
      },
    },
  });

  if (!project) throw new Error("Project not found");
  return project;
}

// ═══════════════════════════════════════════════════════════════════════════
// Get Active Project
// ═══════════════════════════════════════════════════════════════════════════

export async function getActiveProject(workspaceId: string) {
  return db.mktProject.findFirst({
    where: { workspaceId, isActive: true },
    include: {
      _count: { select: { leads: true, deals: true } },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Create Project
// ═══════════════════════════════════════════════════════════════════════════

export async function createProject(
  workspaceId: string,
  data: CreateProjectData,
) {
  return db.mktProject.create({
    data: {
      workspaceId,
      name: data.name,
      description: data.description,
      targetAudience: data.targetAudience || null,
      budgetMin: data.budgetMin ?? null,
      budgetMax: data.budgetMax ?? null,
      adFormats: data.adFormats ? JSON.stringify(data.adFormats) : null,
      language: data.language || "ru",
      agentPersona: data.agentPersona || null,
      idealChannelProfile: data.idealChannelProfile || null,
      badFitExamples: data.badFitExamples || null,
      valueProp: data.valueProp || null,
      toneOfVoice: data.toneOfVoice || null,
      stopWords: data.stopWords ? JSON.stringify(data.stopWords) : null,
      isActive: false,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Update Project
// ═══════════════════════════════════════════════════════════════════════════

export async function updateProject(
  workspaceId: string,
  projectId: string,
  data: UpdateProjectData,
) {
  const existing = await db.mktProject.findFirst({
    where: { id: projectId, workspaceId },
  });
  if (!existing) throw new Error("Project not found");

  const updateData: any = {};

  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.targetAudience !== undefined)
    updateData.targetAudience = data.targetAudience;
  if (data.budgetMin !== undefined) updateData.budgetMin = data.budgetMin;
  if (data.budgetMax !== undefined) updateData.budgetMax = data.budgetMax;
  if (data.adFormats !== undefined)
    updateData.adFormats = JSON.stringify(data.adFormats);
  if (data.language !== undefined) updateData.language = data.language;
  if (data.agentPersona !== undefined)
    updateData.agentPersona = data.agentPersona;
  if (data.idealChannelProfile !== undefined)
    updateData.idealChannelProfile = data.idealChannelProfile;
  if (data.badFitExamples !== undefined)
    updateData.badFitExamples = data.badFitExamples;
  if (data.valueProp !== undefined) updateData.valueProp = data.valueProp;
  if (data.toneOfVoice !== undefined) updateData.toneOfVoice = data.toneOfVoice;
  if (data.stopWords !== undefined)
    updateData.stopWords = JSON.stringify(data.stopWords);

  return db.mktProject.update({
    where: { id: projectId },
    data: updateData,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Activate Project (deactivate all others)
// ═══════════════════════════════════════════════════════════════════════════

export async function activateProject(workspaceId: string, projectId: string) {
  const existing = await db.mktProject.findFirst({
    where: { id: projectId, workspaceId },
  });
  if (!existing) throw new Error("Project not found");

  // Deactivate all projects in this workspace, then activate the target
  await db.$transaction([
    db.mktProject.updateMany({
      where: { workspaceId },
      data: { isActive: false },
    }),
    db.mktProject.update({
      where: { id: projectId },
      data: { isActive: true },
    }),
  ]);

  return db.mktProject.findUnique({
    where: { id: projectId },
    include: { _count: { select: { leads: true, deals: true } } },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Delete Project
// ═══════════════════════════════════════════════════════════════════════════

export async function deleteProject(
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const existing = await db.mktProject.findFirst({
    where: { id: projectId, workspaceId },
  });
  if (!existing) throw new Error("Project not found");

  await db.mktProject.delete({ where: { id: projectId } });
}
