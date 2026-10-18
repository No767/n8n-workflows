import { createHash } from "node:crypto";

export default function gate(): N8nItem<CourseItem | MetaRow>[] {
  const { now, stored, tick, urls, wakeKeys, watched } = $<StartOutput>("Start").first().json;
  const courses = new Map(CONFIG.courses);

  const plannerPages = $<HttpResponse<PlannerItem[]>>("Canvas planner")
    .all()
    .map((item) => item.json);

  const plannerFingerprint =
    plannerPages.length > 0 &&
    !(plannerPages.at(-1)?.headers?.link ?? "").includes('rel="next"') &&
    plannerPages.every(
      (page) =>
        (page.statusCode ?? 0) >= 200 && (page.statusCode ?? 0) < 300 && Array.isArray(page.body),
    )
      ? createHash("sha256")
          .update(
            JSON.stringify(
              plannerPages
                .flatMap((page) => page.body ?? [])
                .filter(
                  ({ course_id: courseId, plannable_type: type }) =>
                    courses.has(courseId) && (type === "assignment" || type === "quiz"),
                )
                .map(({ course_id: courseId, plannable, submissions }) => {
                  const flags = typeof submissions === "object" ? submissions : {};
                  return [
                    courseId,
                    plannable.assignment_id ?? plannable.id,
                    plannable.title,
                    plannable.due_at,
                    plannable.lock_at,
                    Boolean(flags.submitted),
                    Boolean(flags.excused),
                    Boolean(flags.graded),
                    Boolean(flags.missing),
                  ] as const;
                })
                .toSorted((first, second) => first[0] - second[0] || first[1] - second[1]),
            ),
          )
          .digest("hex")
      : undefined;
  const plannerChanged =
    plannerFingerprint !== undefined && plannerFingerprint !== stored.plannerFingerprint;

  const events = $<HttpResponse<AsanaPage<AsanaEvent>>>("Asana events").first().json;
  const token = events.body?.sync ?? stored.asanaSync;
  const watchedGids = new Set(watched.map((task) => task.gid));
  const taskEvents = Map.groupBy(
    (events.body?.data ?? []).filter((event) => event.resource?.resource_type === "task"),
    (event) =>
      (event.action === "deleted" || event.change?.field === "completed") &&
      watchedGids.has(event.resource?.gid ?? "")
        ? "watched"
        : "foreign",
  );

  const canvasLog = plannerPages.map((page): RateLogEntry => ({
    call: "planner",
    cost: numericHeader(page, "x-request-cost"),
    remaining: numericHeader(page, "x-rate-limit-remaining"),
    status: page.statusCode,
  }));

  const idleRows: MetaRow[] =
    token !== "" &&
    token !== stored.asanaSync &&
    (taskEvents.has("foreign") ||
      events.statusCode === 412 ||
      !stored.asanaSyncSavedAt ||
      Temporal.Instant.from(now).since(stored.asanaSyncSavedAt).total("hours") > 6)
      ? [{ key: "asana_sync", owner: "", until: now, value: token }]
      : [];

  if (
    canvasLog.some(
      (entry) => entry.remaining !== undefined && entry.remaining < CONFIG.canvas_min_remaining,
    ) ||
    !(tick === "full" || plannerChanged || wakeKeys.length > 0 || taskEvents.has("watched"))
  )
    return idleRows.map((json) => ({ json }));

  return urls.courses.map((course) => ({
    json: {
      ...course,
      gate: { asanaSync: token, canvasLog, idleRows, plannerChanged, plannerFingerprint },
    },
  }));
}

function numericHeader(page: HttpResponse<unknown>, name: string): number | undefined {
  const value = page.headers?.[name];
  return value ? Number(value) : undefined;
}
