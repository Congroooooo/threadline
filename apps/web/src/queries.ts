// Shared queries. Keys are arrays starting with the workspace id, so a workspace's data
// can be invalidated together. Secrets (new tokens, invite codes) never go through here.
import { useQueries, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api, ApiError } from "./api";
import { type Permission, permissionsOf } from "./permissions";

export const keys = {
  me: ["me"] as const,
  members: (ws: string) => [ws, "members"] as const,
  roles: (ws: string) => [ws, "roles"] as const,
  invites: (ws: string) => [ws, "invites"] as const,
  tokens: (ws: string) => [ws, "tokens"] as const,
  projects: (ws: string) => [ws, "projects"] as const,
  project: (ws: string, id: string) => [ws, "project", id] as const,
  tasks: (ws: string, id: string) => [ws, "tasks", id] as const,
  blockers: (ws: string, id: string) => [ws, "blockers", id] as const,
  openItems: (ws: string, id: string) => [ws, "open-items", id] as const,
  task: (ws: string, id: string) => [ws, "task", id] as const,
};

/** The `:ws` route parameter. */
export function useWs(): string {
  const { ws } = useParams();
  if (!ws) throw new Error("this page needs a workspace in its route");
  return ws;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.error;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: api.me });
export const useMembers = (ws: string) => useQuery({ queryKey: keys.members(ws), queryFn: () => api.members(ws) });
export const useRoles = (ws: string) => useQuery({ queryKey: keys.roles(ws), queryFn: () => api.roles(ws) });
export const useProjects = (ws: string) => useQuery({ queryKey: keys.projects(ws), queryFn: () => api.projects(ws) });

/**
 * What the signed-in person may do in `projectId` (or workspace-wide), worked out from
 * their roles. Only for showing or hiding controls: the server checks every request.
 */
export function useMyPermissions(ws: string, projectId?: string): Set<Permission> {
  const me = useMe();
  const members = useMembers(ws);
  const roles = useRoles(ws);
  const memberId = me.data?.memberships.find((m) => m.workspaceId === ws)?.memberId;
  const member = members.data?.find((m) => m.memberId === memberId);
  return permissionsOf(member, roles.data ?? [], projectId);
}

/** Open items for every project the person can read, for the Inbox and its count. */
export function useInbox(ws: string) {
  const projects = useProjects(ws);
  const list = projects.data ?? [];
  const items = useQueries({
    queries: list.map((p) => ({
      queryKey: keys.openItems(ws, p.id),
      queryFn: () => api.openItems(ws, p.id),
      refetchInterval: 60_000,
    })),
  });
  const sections = list.map((project, i) => ({ project, query: items[i]! }));
  const count = items.reduce((n, q) => n + (q.data ? q.data.handoffs.length + q.data.blockers.length : 0), 0);
  const loading = projects.isPending || items.some((q) => q.isPending);
  const error = projects.error ?? items.find((q) => q.error)?.error ?? null;
  return { sections, count, loading, error };
}
