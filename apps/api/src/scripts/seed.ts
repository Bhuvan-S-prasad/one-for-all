// Dev seed (M1.13): `pnpm db:seed`.
// Creates the owner account through the real first-run setup path if needed,
// then adds sample agents and a welcome thread to the owner's workspace.
import { loadConfig } from "@ofa/config";
import { asId, type WorkspaceId } from "@ofa/core";
import { findInstallOwner, loadRootEnv, seedSampleData } from "@ofa/db";
import { createContainer } from "../container";

loadRootEnv();
const config = loadConfig();
if (config.env === "production") {
  console.error("Refusing to seed a production database.");
  process.exit(1);
}

const email = process.env.SEED_EMAIL ?? "owner@example.com";
const password = process.env.SEED_PASSWORD ?? "dev-password-123";

const container = createContainer(config);
try {
  const { needsSetup } = await container.setup.status();
  if (needsSetup) {
    await container.setup.run({ workspaceName: "Dev workspace", name: "Dev Owner", email, password });
    console.warn(`Created owner ${email} / ${password} (development only).`);
  } else {
    console.warn("Setup already done; seeding the first owner's workspace.");
  }

  const owner = await findInstallOwner(container.db);
  if (!owner) throw new Error("No user found after setup");
  const userId = owner.id;
  const [membership] = await container.sessions.membershipsOf(userId);
  if (!membership) throw new Error(`User ${owner.email} has no workspace`);

  const result = await seedSampleData(container.db, {
    workspaceId: asId<WorkspaceId>(membership.workspaceId),
    userId,
  });
  console.warn(
    `Seeded "${membership.workspaceName}": ${result.agentsCreated} agents` +
      (result.threadCreated ? ", 1 thread." : " (already present)."),
  );
} finally {
  await container.close();
}
