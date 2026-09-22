import { matchesSidebarQuery, sidebarProjectName, sidebarSessionTitle } from "./codex-sidebar-search";
import type { SessionInfo } from "./types";

export interface RecentProject {
  path: string;
  name?: string;
  pinned?: boolean;
  archived: boolean;
  removed: boolean;
}

export interface RecentSessionRow {
  session: SessionInfo;
  projectLabel: string;
}

export interface RecentProjectGroup {
  project: RecentProject;
  projectLabel: string;
  sessions: SessionInfo[];
  latestModified: string;
}

export function buildRecentSessions(
  sessions: readonly SessionInfo[],
  projects: readonly RecentProject[],
  archivedIds: ReadonlySet<string>,
  limit = 8,
): RecentSessionRow[] {
  const activeProjects = new Map(
    projects
      .filter((project) => !project.archived && !project.removed)
      .map((project) => [project.path, project]),
  );

  return sessions
    .filter((session) => session.sessionRole !== "subagent" && !archivedIds.has(session.id))
    .flatMap((session): RecentSessionRow[] => {
      const root = session.projectRoot ?? session.cwd;
      const project = activeProjects.get(root);
      if (!project) return [];
      return [{
        session,
        projectLabel: project.name ?? sidebarProjectName(project.path),
      }];
    })
    .sort((a, b) => b.session.modified.localeCompare(a.session.modified))
    .slice(0, limit);
}

export function filterRecentSessions(
  rows: readonly RecentSessionRow[],
  query: string,
): RecentSessionRow[] {
  if (!query) return [...rows];
  return rows.filter((row) => matchesSidebarQuery([
    sidebarSessionTitle(row.session),
    row.session.firstMessage,
    row.projectLabel,
  ], query));
}

/**
 * The Recent section is capped by session recency, then those sessions are
 * organized beneath their project folder. A pinned project is promoted above
 * other recent folders and retains its latest session even after it falls out
 * of the ordinary recency window.
 */
export function buildRecentProjectGroups(
  sessions: readonly SessionInfo[],
  projects: readonly RecentProject[],
  archivedIds: ReadonlySet<string>,
  limit = 8,
): RecentProjectGroup[] {
  const projectsByPath = new Map(projects.map((project) => [project.path, project]));
  const allRows = buildRecentSessions(sessions, projects, archivedIds, Number.MAX_SAFE_INTEGER);
  const visibleRows = new Map(allRows.slice(0, limit).map((row) => [row.session.id, row]));

  // Pinning is useful only if the folder remains visible after newer activity
  // elsewhere pushes it out of the normal recent-session window.
  for (const project of projects) {
    if (!project.pinned) continue;
    const latestRow = allRows.find((row) => (row.session.projectRoot ?? row.session.cwd) === project.path);
    if (latestRow) visibleRows.set(latestRow.session.id, latestRow);
  }

  const grouped = new Map<string, RecentProjectGroup>();
  for (const row of visibleRows.values()) {
    const root = row.session.projectRoot ?? row.session.cwd;
    const existing = grouped.get(root);
    if (existing) {
      existing.sessions.push(row.session);
      continue;
    }
    const project = projectsByPath.get(root);
    if (!project) continue;
    grouped.set(root, {
      project,
      projectLabel: row.projectLabel,
      sessions: [row.session],
      latestModified: row.session.modified,
    });
  }

  return [...grouped.values()].sort((a, b) =>
    Number(b.project.pinned === true) - Number(a.project.pinned === true)
    || b.latestModified.localeCompare(a.latestModified),
  );
}

export function filterRecentProjectGroups(
  groups: readonly RecentProjectGroup[],
  query: string,
): RecentProjectGroup[] {
  if (!query) return groups.map((group) => ({ ...group, sessions: [...group.sessions] }));
  return groups.flatMap((group) => {
    const projectMatches = matchesSidebarQuery([group.projectLabel, group.project.path], query);
    const sessions = projectMatches
      ? [...group.sessions]
      : group.sessions.filter((session) => matchesSidebarQuery([
        sidebarSessionTitle(session),
        session.firstMessage,
      ], query));
    return sessions.length ? [{ ...group, sessions }] : [];
  });
}
