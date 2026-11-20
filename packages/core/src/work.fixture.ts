// Shared setup for the work and handoff tests: one workspace, two projects and a small team.
import { type Db, type Tx, withWorkspace } from "./db/client.js";
import { createTestDb, seedUser } from "./db/testing.js";
import { newId } from "./ids.js";
import { createProject } from "./projects.js";
import { addMember, createWorkspace, listRoles, setMemberRoles } from "./tenancy.js";
import type { Actor } from "./types.js";

export type Member = Actor & { kind: "member" };
export type Agent = Actor & { kind: "agent" };

export type Team = {
  db: Db;
  workspaceId: string;
  inWs: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Holds every template role workspace-wide. */
  owner: Member;
  backendMember: Member;
  frontendMember: Member;
  /** Holds only the approver role: task.accept but not task.write. */
  approver: Member;
  /** Agents limited to ACME. */
  backendAgent: Agent;
  frontendAgent: Agent;
  acme: string;
  other: string;
  roleIds: Record<string, string>;
  /** A new member with `roleKeys`, workspace-wide or for one project. */
  member(name: string, roleKeys: string[], projectId?: string): Promise<Member>;
  agentOf(m: Member, projectIds: string[]): Agent;
};

export async function seedTeam(): Promise<Team> {
  const db = await createTestDb();
  const ownerUser = await seedUser(db, "Dana");
  const ws = await createWorkspace(db, { name: "Studio", userId: ownerUser, displayName: "Dana" });
  const workspaceId = ws.workspaceId;
  const inWs = <T>(fn: (tx: Tx) => Promise<T>) => withWorkspace(db, workspaceId, fn);
  const owner: Member = { kind: "member", workspaceId, memberId: ws.memberId };

  const member = async (name: string, roleKeys: string[], projectId?: string): Promise<Member> => {
    const uid = await seedUser(db, name);
    const id = await inWs((tx) => addMember(tx, owner, { userId: uid, displayName: name, roleKeys: projectId ? [] : roleKeys }));
    if (projectId) await inWs((tx) => setMemberRoles(tx, owner, { memberId: id, roleKeys, projectId }));
    return { kind: "member", workspaceId, memberId: id };
  };
  const agentOf = (m: Member, projectIds: string[]): Agent => ({
    kind: "agent",
    workspaceId,
    memberId: m.memberId,
    agentId: newId(),
    projectIds,
  });

  const acme = await inWs((tx) => createProject(tx, owner, { key: "ACME", name: "Acme" }));
  const other = await inWs((tx) => createProject(tx, owner, { key: "OTH", name: "Other" }));
  const backendMember = await member("Bo", ["backend"]);
  const frontendMember = await member("Fia", ["frontend"]);
  const approver = await member("Ari", ["approver"]);
  const roleIds = Object.fromEntries((await inWs((tx) => listRoles(tx))).map((r) => [r.key, r.id]));
  return {
    db,
    workspaceId,
    inWs,
    owner,
    backendMember,
    frontendMember,
    approver,
    backendAgent: agentOf(backendMember, [acme]),
    frontendAgent: agentOf(frontendMember, [acme]),
    acme,
    other,
    roleIds,
    member,
    agentOf,
  };
}
