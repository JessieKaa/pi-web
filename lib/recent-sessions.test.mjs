import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  buildRecentProjectGroups,
  buildRecentSessions,
  filterRecentProjectGroups,
  filterRecentSessions,
  parseHiddenRecentSessions,
  pruneHiddenRecentSessions,
} = await createJiti(import.meta.url).import("./recent-sessions.ts");

const projects = [
  { path: "/repos/a", name: "Alpha", archived: false, removed: false },
  { path: "/repos/b", archived: false, removed: false },
];

function session(id, modified, extra = {}) {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: extra.cwd ?? "/repos/a",
    projectRoot: extra.projectRoot ?? extra.cwd ?? "/repos/a",
    name: extra.name,
    firstMessage: extra.firstMessage ?? id,
    created: modified,
    modified,
    messageCount: 1,
    sessionRole: extra.sessionRole ?? "primary",
  };
}

test("returns the eight newest primary sessions with project labels", () => {
  const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`, `2026-08-13T00:${String(i).padStart(2, "0")}:00Z`));
  const rows = buildRecentSessions(sessions, projects, new Set());
  assert.equal(rows.length, 8);
  assert.equal(rows[0].session.id, "s9");
  assert.equal(rows[0].projectLabel, "Alpha");
});

test("excludes archived, subagent, removed-project, and archived-project sessions", () => {
  const rows = buildRecentSessions([
    session("good", "2026-08-13T04:00:00Z"),
    session("archived", "2026-08-13T05:00:00Z"),
    session("child", "2026-08-13T06:00:00Z", { sessionRole: "subagent" }),
    session("removed", "2026-08-13T07:00:00Z", { cwd: "/repos/removed" }),
  ], [...projects, { path: "/repos/removed", archived: false, removed: true }], new Set(["archived"]));
  assert.deepEqual(rows.map((row) => row.session.id), ["good"]);
});

test("falls back to the project directory name", () => {
  const [row] = buildRecentSessions([
    session("b", "2026-08-13T04:00:00Z", { cwd: "/repos/b" }),
  ], projects, new Set());
  assert.equal(row.projectLabel, "b");
});

test("sidebar search keeps matching recent rows by title or project", () => {
  const rows = buildRecentSessions([
    session("keep", "2026-08-13T04:00:00Z", { firstMessage: "Fix sidebar search" }),
    session("other", "2026-08-13T03:00:00Z", { cwd: "/repos/b", firstMessage: "Unrelated" }),
  ], projects, new Set());

  assert.deepEqual(filterRecentSessions(rows, "").map((row) => row.session.id), ["keep", "other"]);
  assert.deepEqual(filterRecentSessions(rows, "sidebar").map((row) => row.session.id), ["keep"]);
  assert.deepEqual(filterRecentSessions(rows, "alpha").map((row) => row.session.id), ["keep"]);
  assert.deepEqual(filterRecentSessions(rows, "missing"), []);
});

test("groups recent sessions under project folders and promotes pinned sessions", () => {
  const groups = buildRecentProjectGroups([
    session("alpha-old", "2026-08-13T02:00:00Z", { firstMessage: "Alpha old" }),
    session("alpha-new", "2026-08-13T04:00:00Z", { firstMessage: "Alpha new" }),
    session("beta-new", "2026-08-13T05:00:00Z", { cwd: "/repos/b", firstMessage: "Beta new" }),
  ], projects, new Set(), new Set(["alpha-new"]));

  assert.deepEqual(groups.map((group) => group.project.path), ["/repos/a", "/repos/b"]);
  assert.deepEqual(groups[0].sessions.map((entry) => entry.id), ["alpha-new", "alpha-old"]);
  assert.equal(groups[0].projectLabel, "Alpha");
});

test("pinned sessions remain visible after falling outside the regular recency cap", () => {
  const groups = buildRecentProjectGroups([
    ...Array.from({ length: 8 }, (_, index) => session(`beta-${index}`, `2026-08-13T00:${String(index + 10).padStart(2, "0")}:00Z`, { cwd: "/repos/b" })),
    session("alpha-old", "2026-08-13T00:01:00Z", { firstMessage: "Pinned Alpha" }),
  ], projects, new Set(), new Set(["alpha-old"]));

  assert.deepEqual(groups.map((group) => group.project.path), ["/repos/a", "/repos/b"]);
  assert.deepEqual(groups[0].sessions.map((entry) => entry.id), ["alpha-old"]);
});

test("removed recent sessions are excluded before the eight-session limit and cannot stay pinned", () => {
  const sessions = [
    ...Array.from({ length: 10 }, (_, index) => session(`new-${index}`, `2026-08-13T00:${String(index + 10).padStart(2, "0")}:00Z`)),
    session("old", "2026-08-13T00:01:00Z", { cwd: "/repos/b" }),
  ];
  const hidden = new Map([
    ["new-9", sessions[9].modified],
    ["old", sessions[10].modified],
  ]);
  const groups = buildRecentProjectGroups(sessions, projects, new Set(), new Set(["old"]), 8, hidden);

  assert.deepEqual(groups.flatMap((group) => group.sessions.map((entry) => entry.id)),
    ["new-8", "new-7", "new-6", "new-5", "new-4", "new-3", "new-2", "new-1"]);
  assert.equal(groups[0].hasPinnedSession, false);
});

test("a removed recent session reappears when its activity changes", () => {
  const original = session("one", "2026-08-13T00:01:00Z");
  const hidden = new Map([[original.id, original.modified]]);
  assert.deepEqual(buildRecentProjectGroups([original], projects, new Set(), new Set(), 8, hidden), []);

  const active = { ...original, modified: "2026-08-13T00:02:00Z" };
  assert.deepEqual(buildRecentProjectGroups([active], projects, new Set(), new Set(), 8, hidden)[0].sessions.map((entry) => entry.id), ["one"]);
});

test("archiving and restoring a removed session keeps it hidden until new activity", () => {
  const original = session("one", "2026-08-13T00:01:00Z");
  const hidden = new Map([[original.id, original.modified]]);
  const whileArchived = pruneHiddenRecentSessions(hidden, []);
  assert.deepEqual([...whileArchived], [[original.id, original.modified]]);
  assert.deepEqual(buildRecentProjectGroups([original], projects, new Set([original.id]), new Set(), 8, whileArchived), []);
  assert.deepEqual(buildRecentProjectGroups([original], projects, new Set(), new Set(), 8, whileArchived), []);
  assert.deepEqual([...pruneHiddenRecentSessions(whileArchived, [{ ...original, modified: "2026-08-13T00:02:00Z" }])], []);
});

test("persisted recent removals ignore malformed entries", () => {
  assert.deepEqual([...parseHiddenRecentSessions(null)], []);
  assert.deepEqual([...parseHiddenRecentSessions("invalid")], []);
  assert.deepEqual([...parseHiddenRecentSessions(JSON.stringify([
    ["one", "2026-08-13T00:01:00Z"],
    ["broken"],
    [42, "2026-08-13T00:02:00Z"],
    { id: "wrong-shape" },
  ]))], [["one", "2026-08-13T00:01:00Z"]]);
});

test("filtering a recent project folder retains all of its visible sessions", () => {
  const groups = buildRecentProjectGroups([
    session("alpha-one", "2026-08-13T04:00:00Z", { firstMessage: "First" }),
    session("alpha-two", "2026-08-13T03:00:00Z", { firstMessage: "Second" }),
    session("beta", "2026-08-13T02:00:00Z", { cwd: "/repos/b", firstMessage: "Other" }),
  ], projects, new Set());

  assert.deepEqual(filterRecentProjectGroups(groups, "alpha")[0].sessions.map((entry) => entry.id), ["alpha-one", "alpha-two"]);
  assert.deepEqual(filterRecentProjectGroups(groups, "second").map((group) => group.sessions.map((entry) => entry.id)), [["alpha-two"]]);
  assert.deepEqual(filterRecentProjectGroups(groups, "missing"), []);
});
