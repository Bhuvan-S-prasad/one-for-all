export {
  createDatabase,
  pingDatabase,
  type CreateDatabaseOptions,
  type Database,
  type DatabaseHandle,
  type Schema,
} from "./client";
export { findRepoRoot, loadRootEnv } from "./env";
export { MIGRATIONS_FOLDER, runMigrations } from "./migrate";
export { recordAudit, type AuditEntry } from "./repos/audit";
export {
  deleteSecret,
  findSecretById,
  findSecretByName,
  listSecrets,
  markSecretUsed,
  upsertSecret,
  type SecretRecord,
  type SecretWrite,
} from "./repos/secrets";
export {
  bootstrapOwner,
  findInstallOwner,
  isSetupComplete,
  type BootstrapOwnerInput,
  type BootstrapOwnerResult,
} from "./repos/setup";
export {
  getWorkspace,
  listMembershipsForUser,
  type MembershipRole,
  type WorkspaceMembership,
  type WorkspaceRecord,
} from "./repos/workspaces";
export * as schema from "./schema/index";
export { seedSampleData } from "./seed/sample-data";
export {
  setTenantSettings,
  TENANT_TABLES,
  withTenant,
  withUser,
  type Executor,
  type Tx,
} from "./tenant";
export { prepareTestDatabase, withDatabaseName, type TestDatabase } from "./testing";
