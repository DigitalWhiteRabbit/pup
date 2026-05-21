/**
 * One-off script: create Service Account for Atlas Agents.
 *
 * Run on prod:
 *   npx tsx scripts/create-atlas-service-account.ts
 *
 * Outputs the Bearer token ONCE — save it immediately.
 */

import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const WORKSPACE_ID = "cmp5aou0h0005l5b26ldwn59c"; // Ananas

const SCOPES = [
  "tasks:read",
  "tickets:read",
  "tickets:analytics",
  "customers:read",
  "leads:read",
  "marketing:analytics",
  "kb:read",
  "users:read",
  "dashboard:read",
];

const ALLOWED_IPS = ["187.127.88.96"]; // Atlas Agents Hostinger VPS

async function main() {
  // Verify workspace exists
  const ws = await db.workspace.findUnique({ where: { id: WORKSPACE_ID } });
  if (!ws) {
    console.error(`Workspace ${WORKSPACE_ID} not found. Are you on prod?`);
    process.exit(1);
  }

  // Check for existing active service account
  const existing = await db.serviceAccount.findFirst({
    where: { workspaceId: WORKSPACE_ID, isActive: true },
  });
  if (existing) {
    console.error(
      `Active service account already exists: "${existing.name}" (${existing.id})`,
    );
    console.error("Deactivate it first or use the admin API to rotate token.");
    process.exit(1);
  }

  // Generate token + hash
  const token = `pup_sa_${crypto.randomBytes(32).toString("hex")}`;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  // Create record
  const sa = await db.serviceAccount.create({
    data: {
      name: "Atlas Agents",
      tokenHash,
      scopes: JSON.stringify(SCOPES),
      allowedIPs: JSON.stringify(ALLOWED_IPS),
      workspaceId: WORKSPACE_ID,
    },
  });

  console.log("=".repeat(60));
  console.log("Service Account created successfully!");
  console.log("=".repeat(60));
  console.log(`ID:          ${sa.id}`);
  console.log(`Name:        ${sa.name}`);
  console.log(`Workspace:   ${ws.name} (${WORKSPACE_ID})`);
  console.log(`Scopes:      ${SCOPES.join(", ")}`);
  console.log(`Allowed IPs: ${ALLOWED_IPS.join(", ")}`);
  console.log("=".repeat(60));
  console.log("BEARER TOKEN (save this — it will NOT be shown again):");
  console.log("");
  console.log(`  ${token}`);
  console.log("");
  console.log("=".repeat(60));
  console.log("Atlas Agents env vars:");
  console.log(`  ATLAS_PUP_BASE_URL=https://pupanel.cc`);
  console.log(`  ATLAS_PUP_API_TOKEN=${token}`);
  console.log(`  ATLAS_PUP_WORKSPACE_ID=${WORKSPACE_ID}`);
  console.log("=".repeat(60));

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
