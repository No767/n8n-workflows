type Column = (typeof COLUMNS)[number];
type LedgerColumns = Record<Column, null | number | string> & { canvas_key: string };

interface Outcome {
  done: string[];
  errors: string[];
  plan: Plan;
  row: PlannedRow;
}

const RETRY_BACKOFF_MIN = [5, 15, 60, 360];
const COLUMNS = [
  "course_id",
  "assignment_id",
  "title",
  "lifecycle",
  "section",
  "item_fp",
  "asana_state",
  "asana_gid",
  "asana_written",
  "gcal_state",
  "gcal_written",
  "ntfy",
  "wake_at",
  "gone_since",
  "retry_count",
  "last_error",
] as const;

export default function commit(): N8nItem<
  LedgerColumns | MetaRow | { drop: string } | { summary: unknown }
>[] {
  const { order } = $<{ order: Order }>("From check").first().json;
  const { counts, cut, plans } = $<PlanSummary>("Plan").last().json;
  const stored = new Map(
    $<RawLedgerRow>("Read ledger")
      .all()
      .map((item) => [item.json.canvas_key, item.json]),
  );

  const outcomes = plans.map((plan): Outcome => ({
    done: [],
    errors: [],
    plan,
    row: { ...plan.row, last_error: "", retry_count: 0 },
  }));

  const ledgerItems: LedgerColumns[] = [];
  const drops: string[] = [];
  const changes: string[] = [];

  const results = $<ActionResult | PlanSummary>("Loop")
    .all()
    .map((item) => item.json)
    .filter((json) => "action" in json)
    .toSorted(
      (first, second) =>
        first.action.planIndex - second.action.planIndex ||
        first.action.index - second.action.index,
    );

  for (const { action, error, gid, outcome } of results) {
    const { done, errors, plan, row } = outcomes[action.planIndex];

    switch (outcome) {
      case "adopted": {
        outcomes[action.planIndex].row = {
          ...row,
          asana_gid: gid ?? "",
          asana_state: "live",
          asana_written: undefined,
          section: "",
          wake_at: order.now,
        };
        done.push(`${action.kind} → adopted existing task`);
        break;
      }
      case "fail": {
        errors.push(`${plan.key} ${action.kind} → ${error ?? "no detail"}`);
        row.retry_count = plan.row.retry_count + 1;
        row.last_error = (errors.at(-1) ?? "").slice(0, 500);
        row.wake_at = [
          row.wake_at,
          Temporal.Instant.from(order.now)
            .add({ minutes: RETRY_BACKOFF_MIN.slice(0, row.retry_count).at(-1) ?? 0 })
            .toString(),
        ]
          .filter((time) => time !== undefined)
          .toSorted((first, second) => Temporal.Instant.compare(first, second))
          .at(0);
        break;
      }
      case "ok": {
        const { ntfyAdd, ntfyRemove, ...fields } = action.patch;
        outcomes[action.planIndex].row = {
          ...row,
          ...fields,
          ...(action.kind === "createTask" && { asana_gid: gid }),
          ntfy: [...row.ntfy, ntfyAdd].filter(
            (reminder): reminder is Reminder =>
              reminder !== undefined && reminder.id !== ntfyRemove,
          ),
        };
        done.push(action.kind);
        break;
      }
      case "taskGone": {
        outcomes[action.planIndex].row = {
          ...row,
          asana_state: "hand_deleted",
          wake_at: order.now,
        };
        done.push(`${action.kind} 404 → hand_deleted`);
        break;
      }
    }
  }

  for (const { done, errors, plan, row } of outcomes) {
    const doneList = done.join(", ");
    if (plan.drop && errors.length === 0) {
      drops.push(plan.key);
      changes.push(`${plan.key} removed: gone from Canvas [${doneList || "nothing to delete"}]`);
      continue;
    }
    const columns: LedgerColumns = {
      asana_gid: row.asana_gid,
      asana_state: row.asana_state,
      asana_written: writtenColumn(row.asana_written, row.asana_state !== "none"),
      assignment_id: row.assignment_id,
      canvas_key: row.canvas_key,
      course_id: row.course_id,
      gcal_state: row.gcal_state,
      gcal_written: writtenColumn(row.gcal_written, row.gcal_state === "live"),
      gone_since: dateColumn(row.gone_since),
      item_fp: row.item_fp,
      last_error: row.last_error ?? "",
      lifecycle: row.lifecycle,
      ntfy: JSON.stringify(row.ntfy),
      retry_count: row.retry_count,
      section: row.section,
      title: row.title,
      wake_at: dateColumn(row.wake_at),
    };
    const before = stored.get(plan.key);
    if (
      !before ||
      COLUMNS.some(
        (column) => comparableColumn(before[column]) !== comparableColumn(columns[column]),
      )
    ) {
      ledgerItems.push(columns);
      changes.push(
        `${plan.key} ${plan.previousLifecycle}/${plan.previousAsanaState}→${row.lifecycle}/${row.asana_state} [${doneList || "state only"}]`,
      );
    }
  }

  return [
    ...ledgerItems,
    ...drops.map((key) => ({ drop: key })),
    ...(
      [
        ["asana_sync", order.asanaSync],
        ["full_fp", cut.length > 0 ? "cut" : order.fullFingerprint],
        ["planner_fp", order.plannerFingerprint ?? ""],
      ] as const
    )
      .filter(([, value]) => value)
      .map(([key, value]) => ({ key, owner: "", until: order.now, value })),
    {
      summary: {
        actions: counts,
        canvas: order.canvasLog,
        changes,
        cut,
        errors: outcomes.flatMap((outcome) => outcome.errors),
        reasons: order.reasons,
        removed: drops.length,
        rowsChanged: ledgerItems.length,
      },
    },
  ].map((json) => ({ json }));
}

function comparableColumn(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return "";
  return /^\d{4}-\d\d-\d\dT/.test(value) ? Temporal.Instant.from(value).toString() : value;
}

function dateColumn(value: string | undefined): null | string {
  // oxlint-disable-next-line unicorn/no-null -- The Data Table clears a column only for null, and undefined would be dropped from the item's JSON and leave the old date in place.
  return value ?? null;
}

function writtenColumn(value: unknown, live: boolean): string {
  return live && value !== undefined ? JSON.stringify(value) : "";
}
