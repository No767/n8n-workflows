import { createHash } from "node:crypto";

const SKIP_TYPES = new Set(["none", "on_paper"]);
const IGNORED_ITEMS = new Set(CONFIG.ignore_items);

export default function decide(): N8nItem<MetaRow | { order: Order }>[] {
  const { manual, now, stored, urls, wakeKeys, watched } = $<StartOutput>("Start").first().json;
  const { gate } = $<CourseItem>("Gate").first().json;

  const courses = urls.courses.map(({ courseId }, run) => {
    const pages = $<HttpResponse<CanvasAssignment[]>>("Canvas assignments")
      .all(0, run)
      .map((item) => item.json);
    const complete =
      pages.length > 0 &&
      !(pages.at(-1)?.headers?.link ?? "").includes('rel="next"') &&
      pages.every(
        (page) =>
          (page.statusCode ?? 0) >= 200 && (page.statusCode ?? 0) < 300 && Array.isArray(page.body),
      );
    return { complete, courseId, pages, refused: pages.some((page) => page.statusCode === 403) };
  });

  const snapshots = courses.map(({ complete, courseId, pages, refused }): Snapshot => ({
    complete,
    courseId,
    items: (complete ? pages.flatMap((page) => page.body ?? []) : []).map(
      (assignment): SnapshotItem => {
        const submission = assignment.submission ?? {};
        const description = (assignment.description ?? "")
          .replaceAll(/<[^<>]*>/g, " ")
          .replaceAll("&nbsp;", " ")
          .replaceAll(/\s+/g, " ")
          .trim();
        return {
          course_id: assignment.course_id,
          description,
          due_at: assignment.due_at ?? undefined,
          fingerprint: sha256(
            JSON.stringify([
              assignment.course_id,
              assignment.id,
              assignment.name,
              assignment.due_at,
              assignment.unlock_at,
              assignment.lock_at,
              assignment.submission_types.toSorted(),
              assignment.published,
              sha256(description),
              submission.excused === true,
              submission.submitted_at,
              submission.workflow_state,
              submission.missing === true,
            ]),
          ),
          html_url: assignment.html_url,
          id: assignment.id,
          inScope:
            !IGNORED_ITEMS.has(assignment.id) &&
            assignment.due_at !== null &&
            assignment.published !== false &&
            !assignment.submission_types.every((type) => SKIP_TYPES.has(type)),
          lock_at: assignment.lock_at ?? undefined,
          name: assignment.name,
          submission: {
            excused: submission.excused ?? undefined,
            missing: submission.missing ?? undefined,
            submitted_at: submission.submitted_at ?? undefined,
            workflow_state: submission.workflow_state ?? undefined,
          },
          submission_types: assignment.submission_types,
          unlock_at: assignment.unlock_at ?? undefined,
        };
      },
    ),
    refused,
  }));
  const fullFingerprint =
    sha256(
      JSON.stringify(
        snapshots
          .filter((snapshot) => snapshot.complete)
          .flatMap((snapshot) =>
            snapshot.items
              .filter((item) => item.inScope)
              .map((item) => [[item.course_id, item.id].join(":"), item.fingerprint]),
          )
          .toSorted(([firstKey], [secondKey]) => (firstKey < secondKey ? -1 : 1)),
      ),
    ) + (snapshots.every((snapshot) => snapshot.complete) ? "" : ":partial");

  const taskPages = $<HttpResponse<AsanaPage<{ completed: boolean; gid: string }>>>("Asana tasks")
    .all()
    .map((item) => item.json);
  const taskListComplete =
    taskPages.length > 0 &&
    !taskPages.at(-1)?.body?.next_page &&
    taskPages.every((page) => page.statusCode === 200 && Array.isArray(page.body?.data));
  const seen = new Map(
    taskPages
      .flatMap((page) => page.body?.data ?? [])
      .map((task) => [task.gid, task.completed ? "completed" : "open"] as const),
  );

  const canvasLog = [
    ...gate.canvasLog,
    ...courses.flatMap((course) =>
      course.pages.map((page): RateLogEntry => ({
        call: `course ${String(course.courseId)}`,
        cost: numericHeader(page, "x-request-cost"),
        remaining: numericHeader(page, "x-rate-limit-remaining"),
        status: page.statusCode,
      })),
    ),
  ];
  const backoff = canvasLog.some(
    (entry) => entry.remaining !== undefined && entry.remaining < CONFIG.canvas_min_remaining,
  );
  const reasons = (
    [
      ["canvas", fullFingerprint !== stored.fullFingerprint],
      ["wake", wakeKeys.length > 0],
      [
        "asana",
        taskListComplete &&
          watched.some(
            (task) => (seen.get(task.gid) ?? "absent") !== (task.completed ? "completed" : "open"),
          ),
      ],
      ["manual", manual],
    ] as const
  )
    .filter(([, applies]) => applies)
    .map(([reason]) => reason);

  if (reasons.length === 0 || backoff) {
    return [
      ...(gate.plannerFingerprint && gate.plannerChanged && !backoff
        ? [{ key: "planner_fp", owner: "", until: now, value: gate.plannerFingerprint }]
        : []),
      ...(taskListComplete && gate.asanaSync && gate.asanaSync !== stored.asanaSync
        ? [{ key: "asana_sync", owner: "", until: now, value: gate.asanaSync }]
        : gate.idleRows),
    ].map((json) => ({ json }));
  }
  return [
    {
      json: {
        order: {
          asanaSeen: taskListComplete
            ? watched.map((task) => [task.gid, seen.get(task.gid) ?? "absent"])
            : undefined,
          asanaSync: gate.asanaSync,
          canvasLog,
          fullFingerprint,
          now,
          plannerFingerprint: gate.plannerFingerprint,
          reasons,
          snapshots,
        },
      },
    },
  ];
}

function numericHeader(page: HttpResponse<unknown>, name: string): number | undefined {
  const value = page.headers?.[name];
  return value ? Number(value) : undefined;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
