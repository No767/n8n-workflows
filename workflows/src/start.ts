import { URL, URLSearchParams } from "node:url";

const ASANA_API = "https://app.asana.com/api/1.0";
const CANVAS_API = `${CONFIG.canvas.base_url}/api/v1`;
const ZONE = "America/Los_Angeles";

export default function start(): N8nItem<StartOutput>[] {
  const clock = Temporal.Now.zonedDateTimeISO(ZONE).round({
    roundingMode: "trunc",
    smallestUnit: "second",
  });
  const manual = $("Run now").isExecuted;
  const meta = new Map(
    $<MetaRow>("Read meta")
      .all()
      .map((item) => [item.json.key, item.json]),
  );
  const asanaSync = meta.get("asana_sync");
  const ledger = $<RawLedgerRow>("Read ledger")
    .all()
    .map((item) => item.json)
    .filter(
      (row) =>
        row.canvas_key && CONFIG.courses.some(([courseId]) => courseId === Number(row.course_id)),
    );

  return [
    {
      json: {
        leaseMinutes: CONFIG.lease_minutes,
        manual,
        now: clock.toInstant().toString(),
        stored: {
          asanaSync: asanaSync?.value ?? "",
          asanaSyncSavedAt: asanaSync?.until,
          fullFingerprint: meta.get("full_fp")?.value,
          plannerFingerprint: meta.get("planner_fp")?.value,
        },
        tick: manual || clock.minute % 5 === 0 ? "full" : "planner",
        urls: {
          asanaEvents: apiUrl(`${ASANA_API}/events`, {
            resource: CONFIG.asana.project,
            ...(asanaSync?.value ? { sync: asanaSync.value } : {}),
          }),
          asanaTasks: apiUrl(`${ASANA_API}/projects/${CONFIG.asana.project}/tasks`, {
            limit: "100",
            opt_fields: "completed",
          }),
          courses: CONFIG.courses.map(([courseId]) => ({
            courseId,
            url: apiUrl(`${CANVAS_API}/courses/${String(courseId)}/assignments`, {
              "include[]": "submission",
              per_page: "100",
            }),
          })),
          planner: apiUrl(`${CANVAS_API}/planner/items`, {
            end_date: clock.toPlainDate().add({ days: 120 }).toString(),
            per_page: "100",
            start_date: clock.toPlainDate().subtract({ days: 14 }).toString(),
          }),
        },
        wakeKeys: ledger
          .filter(
            (row) => row.wake_at && Temporal.Instant.compare(row.wake_at, clock.toInstant()) <= 0,
          )
          .map((row) => row.canvas_key),
        watched: ledger
          .filter(
            (row) =>
              row.asana_gid &&
              (row.asana_state === "hand_completed" ||
                (row.asana_state === "live" && row.lifecycle !== "done")),
          )
          .map((row) => ({
            completed: row.asana_state === "hand_completed",
            gid: row.asana_gid ?? "",
          })),
      },
    },
  ];
}

function apiUrl(url: string, query: Record<string, string>): string {
  return new URL(`${url}?${new URLSearchParams(query).toString()}`).href;
}
