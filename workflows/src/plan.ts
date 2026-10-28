import { createHash } from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import { isDeepStrictEqual } from "node:util";

interface DueShape {
  asana: AsanaDates;
  date: Temporal.PlainDate; // the date it shows on
  gcal: { end: Record<string, string>; start: Record<string, string> };
  kind: "endOfDay" | "timedAllDay" | "timedBlock";
  opensAt?: string; // a timedBlock's start
  titleSuffix?: string;
}

interface LedgerRow {
  asana_gid: string;
  asana_state: AsanaState;
  asana_written?: AsanaWritten;
  gcal_state: "live" | "none";
  gcal_written?: CalendarEvent;
  gone_since?: string;
  item_fp: string;
  lifecycle: Lifecycle;
  ntfy: Reminder[];
  retry_count: number;
  section: Section;
  title: string;
}

type RowAction = Omit<Action, "index" | "key" | "planIndex">;

interface Slot extends Reminder {
  priority: number;
  slot: SlotName;
}

type SlotName = "eve" | "last" | "noon" | "opens";

type Want = "createTask" | "deleteTask" | "event" | "priority" | "reminders" | "taskWrites";

const ASANA_API = "https://app.asana.com/api/1.0";
const EVENTS_URL = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.calendar.id)}/events`;
const ZONE = "America/Los_Angeles";

const TIME = { hour: "numeric", minute: "2-digit" } as const;
const SLOT_TAGS: Record<SlotName, string> = {
  eve: "date",
  last: "rotating_light",
  noon: "hourglass_flowing_sand",
  opens: "unlock",
};
const HORIZON = { hours: 70 };
const LOCK_GRACE = { minutes: 2 };
const GONE_CONFIRM = { minutes: 5 };
const TARGETS = ["asana", "gcal", "ntfy"] as const;
const ASANA_DATES = ["due_at", "due_on", "start_at", "start_on"] as const;
const PRIORITY_STEPS: [number, Priority][] = [
  [0, "critical"],
  [1, "high"],
  [20, "medium"],
]; // at most this many days left, else low
const ASANA_STATES = new Set<string>(["hand_completed", "hand_deleted", "live", "none"]);
const DONE_STATES = new Set<string | undefined>(["pending_review", "submitted"]);
const HAND_CHANGES = new Map<string, AsanaState>([
  ["hand_completed/absent", "hand_deleted"],
  ["hand_completed/open", "live"],
  ["live/absent", "hand_deleted"],
  ["live/completed", "hand_completed"],
]);
const WANTS = new Map<string, Want[]>([
  ["done/hand_completed", ["taskWrites"]],
  ["done/live", ["taskWrites"]],
  ["gone/hand_completed", ["deleteTask"]],
  ["gone/live", ["deleteTask"]],
  ["missed/live", ["taskWrites"]],
  ["missed/none", ["createTask"]],
  ["open/live", ["event", "priority", "reminders", "taskWrites"]],
  ["open/none", ["createTask", "event", "priority", "reminders"]],
]);

class EventPlanner {
  readonly #row: Row;

  constructor(row: Row) {
    this.#row = row;
  }

  delete(): RowAction[] {
    const { key, stored, wanted } = this.#row;
    if (wanted.has("event") || stored.gcal_state !== "live") return [];
    return [
      {
        kind: "deleteEvent",
        method: "DELETE",
        patch: { gcal_state: "none" },
        route: "gcalDelete",
        target: "gcal",
        url: gcalUrl(eventId(key)),
      },
    ];
  }

  insert(item: Item): RowAction[] {
    const { key, stored, wanted } = this.#row;
    if (!wanted.has("event") || stored.gcal_state === "live") return [];
    const noReminders = { overrides: [], useDefault: false };
    return [
      {
        body: { id: eventId(key), ...item.event, reminders: noReminders },
        kind: "insertEvent",
        method: "POST",
        patch: { gcal_state: "live", gcal_written: item.event },
        reviveBody: { ...item.event, reminders: noReminders, status: "confirmed" },
        reviveUrl: gcalUrl(eventId(key)),
        route: "gcalWrite",
        target: "gcal",
        url: gcalUrl(),
      },
    ];
  }

  update(item: Item): RowAction[] {
    const { key, stored, wanted } = this.#row;
    if (
      !wanted.has("event") ||
      stored.gcal_state !== "live" ||
      isDeepStrictEqual(stored.gcal_written, item.event)
    )
      return [];
    return [
      {
        body: item.event,
        kind: "patchEvent",
        method: "PATCH",
        patch: { gcal_written: item.event },
        route: "gcalWrite",
        target: "gcal",
        url: gcalUrl(eventId(key)),
      },
    ];
  }
}

class Item {
  readonly assignment: SnapshotItem;
  readonly course: CourseConfig;
  readonly due: DueShape;
  readonly dueLocal: Temporal.ZonedDateTime;
  readonly event: CalendarEvent; // without its id and reminders
  readonly lifecycle: "done" | "missed" | "open";
  readonly notes: string;
  readonly task: AsanaWritten;
  readonly title: string;

  get reminderSlots(): Slot[] {
    const dueAt = this.dueLocal.toInstant();
    const onDueDate = (days: number, plainTime: string) =>
      this.due.date.add({ days }).toZonedDateTime({ plainTime, timeZone: ZONE }).toInstant();
    const slots: [SlotName, Temporal.Instant, number][] = [["eve", onDueDate(-1, "19:00"), 3]];
    if (this.due.kind === "endOfDay") {
      slots.push(["noon", onDueDate(0, "12:00"), 4], ["last", dueAt.subtract({ hours: 2 }), 5]);
    } else if (this.due.opensAt && dueAt.since(this.due.opensAt).total("hours") <= 2) {
      slots.push(["opens", Temporal.Instant.from(this.due.opensAt).subtract({ minutes: 5 }), 3]);
    } else {
      slots.push(["last", dueAt.subtract({ hours: 1 }), 5]);
    }
    const idPrefix = eventId([this.assignment.course_id, this.assignment.id].join(":"));
    return slots.map(([slot, at, priority]) => ({
      at: at.toString(),
      id: `${idPrefix}-${slot}-${at.toString().slice(0, 16).replaceAll(/\D/g, "")}`,
      priority,
      slot,
    }));
  }

  constructor(assignment: SnapshotItem, course: CourseConfig, now: string) {
    const { submission } = assignment;
    this.assignment = assignment;
    this.course = course;
    if (
      submission.excused === true ||
      typeof submission.submitted_at === "string" ||
      DONE_STATES.has(submission.workflow_state) ||
      (assignment.submission_types.includes("external_tool") &&
        submission.workflow_state === "graded")
    )
      this.lifecycle = "done";
    else if (
      assignment.lock_at
        ? Temporal.Instant.compare(assignment.lock_at, now) <= 0
        : submission.missing === true
    )
      this.lifecycle = "missed";
    else this.lifecycle = "open";

    const dueAt = assignment.due_at ?? ""; // in scope means it has one
    const unlockAt =
      assignment.unlock_at && assignment.unlock_at < dueAt ? assignment.unlock_at : "";
    const local = (iso: string) => ({
      dateTime: Temporal.Instant.from(iso)
        .toZonedDateTimeISO(ZONE)
        .toString({ timeZoneName: "never" }),
      timeZone: ZONE,
    });
    this.dueLocal = Temporal.Instant.from(dueAt).toZonedDateTimeISO(ZONE);
    const clock = this.dueLocal.toPlainTime().toString();
    const date = this.dueLocal.subtract({ seconds: 1 }).toPlainDate(); // 00:00 shows on the previous date
    const allDay = {
      end: { date: date.add({ days: 1 }).toString() },
      start: { date: date.toString() },
    };
    if (clock === "00:00:00" || clock.startsWith("23:59")) {
      const unlockDate = unlockAt
        ? Temporal.Instant.from(unlockAt).toZonedDateTimeISO(ZONE).toPlainDate()
        : date;
      this.due = {
        asana: {
          due_on: date.toString(),
          ...(CONFIG.asana.start_dates &&
            Temporal.PlainDate.compare(unlockDate, date) < 0 && {
              start_on: unlockDate.toString(),
            }),
        },
        date,
        gcal: allDay,
        kind: "endOfDay",
      };
    } else if (unlockAt) {
      this.due = {
        asana: { due_at: dueAt, ...(CONFIG.asana.start_dates && { start_at: unlockAt }) },
        date,
        gcal: { end: local(dueAt), start: local(unlockAt) },
        kind: "timedBlock",
        opensAt: unlockAt,
      };
    } else {
      this.due = {
        asana: { due_at: dueAt },
        date,
        gcal: allDay,
        kind: "timedAllDay",
        titleSuffix: ` (due ${this.dueLocal.toLocaleString("en-US", TIME)})`,
      };
    }
    this.title = `${course.label} · ${assignment.name}`;
    this.event = {
      description: assignment.html_url,
      end: this.due.gcal.end,
      start: this.due.gcal.start,
      summary: this.title + (this.due.titleSuffix ?? ""),
    };
    this.notes = `${assignment.description.slice(0, 4000)}\n\n${assignment.html_url}`.trim();
    this.task = {
      completed: this.lifecycle === "done",
      due: this.due.asana,
      name: assignment.name,
      notesHash: createHash("sha256").update(this.notes).digest("hex"),
    };
  }

  section(storedSection: Section): Section {
    if (this.lifecycle === "missed" || (this.lifecycle === "done" && storedSection === "missed"))
      return "missed";
    return this.course.match &&
      new RegExp(this.course.match.pattern, "i").test(this.assignment.name)
      ? "matched"
      : "class";
  }

  sectionGid(section: Section): string {
    if (section === "missed") return CONFIG.asana.missed_section;
    return section === "matched" && this.course.match
      ? this.course.match.section
      : this.course.section;
  }
}

class ReminderPlanner {
  readonly pending: Reminder[];
  readonly #asanaGid: string;
  readonly #item: Item;
  readonly #later: Slot[];
  readonly #onNtfy: Slot[];
  readonly #wantedIds: Set<string>;

  constructor(row: Row, item: Item) {
    const soonest = Temporal.Instant.from(row.now).add({ minutes: 1 });
    const horizon = Temporal.Instant.from(row.now).add(HORIZON);
    const wanted = row.wanted.has("reminders") ? item.reminderSlots : [];
    this.pending = row.stored.ntfy.filter(
      (reminder) => Temporal.Instant.compare(reminder.at, row.now) > 0,
    );
    this.#asanaGid = row.stored.asana_gid;
    this.#item = item;
    this.#wantedIds = new Set(wanted.map((slot) => slot.id));
    this.#onNtfy = wanted.filter(
      (slot) =>
        Temporal.Instant.compare(slot.at, soonest) > 0 &&
        Temporal.Instant.compare(slot.at, horizon) <= 0,
    );
    this.#later = wanted.filter((slot) => Temporal.Instant.compare(slot.at, horizon) > 0);
  }

  cancelUnwanted(): RowAction[] {
    return this.pending
      .filter((reminder) => !this.#wantedIds.has(reminder.id))
      .map((reminder) => cancelReminder(reminder.id));
  }

  schedule(): RowAction[] {
    const { assignment, course, dueLocal } = this.#item;
    const time =
      dueLocal.hour === 0 && dueLocal.minute === 0
        ? "midnight"
        : dueLocal.toLocaleString("en-US", TIME);
    const message = (slot: Slot): string => {
      switch (slot.slot) {
        case "eve": {
          return `Due tomorrow at ${time}`;
        }
        case "last": {
          const hours = Math.round(dueLocal.toInstant().since(slot.at).total("hours"));
          return `${String(hours)} ${hours === 1 ? "hour" : "hours"} left, due ${time}`;
        }
        case "noon": {
          return `Due today at ${time}`;
        }
        case "opens": {
          return `Opens in 5 min, closes ${time}`;
        }
      }
    };
    const pendingIds = new Set(this.pending.map((reminder) => reminder.id));
    return this.#onNtfy
      .filter((slot) => !pendingIds.has(slot.id))
      .map((slot) => ({
        body: {
          actions: [
            {
              action: "view",
              clear: true,
              label: slot.slot === "opens" ? "Start in Canvas" : "Open in Canvas",
              url: assignment.html_url,
            },
            ...(this.#asanaGid && slot.slot !== "opens"
              ? [
                  {
                    action: "view",
                    clear: true,
                    label: "Asana task",
                    url: `https://app.asana.com/0/${CONFIG.asana.project}/${this.#asanaGid}`,
                  },
                ]
              : []),
          ],
          click: assignment.html_url,
          delay: String(Temporal.Instant.from(slot.at).epochMilliseconds / 1000),
          message: message(slot),
          priority: slot.priority,
          sequence_id: slot.id,
          tags: [SLOT_TAGS[slot.slot]],
          title: `[${course.label}] ${assignment.name}`,
          topic: CONFIG.ntfy.topic,
        },
        kind: "schedule",
        method: "POST",
        patch: { ntfyAdd: { at: slot.at, id: slot.id } },
        route: "ntfySchedule",
        target: "ntfy",
        url: `${CONFIG.ntfy.base_url}/`,
      }));
  }

  wakes(): Temporal.Instant[] {
    return this.#later.map((slot) => Temporal.Instant.from(slot.at).subtract(HORIZON));
  }
}

class Row {
  readonly item?: Item;
  readonly key: string;
  readonly now: string;
  readonly plan: Plan;
  readonly skipped: boolean;
  readonly stored: LedgerRow;
  readonly wanted: Set<Want>;

  constructor(
    key: string,
    raw: Partial<RawLedgerRow>,
    assignment: SnapshotItem | undefined,
    course: CourseConfig | undefined,
    run: { asanaSeen: Map<string, TaskSeen>; now: string },
  ) {
    const stored: LedgerRow = {
      asana_gid: raw.asana_gid ?? "",
      asana_state: ASANA_STATES.has(raw.asana_state ?? "")
        ? (raw.asana_state as AsanaState)
        : "none",
      asana_written: parseJson(raw.asana_written) as AsanaWritten | undefined,
      gcal_state: raw.gcal_state === "live" ? "live" : "none",
      gcal_written: parseJson(raw.gcal_written) as CalendarEvent | undefined,
      gone_since: raw.gone_since
        ? Temporal.Instant.from(raw.gone_since).toString({ smallestUnit: "second" })
        : undefined,
      item_fp: raw.item_fp ?? "",
      lifecycle: (raw.lifecycle ?? "none") as Lifecycle,
      ntfy: (parseJson(raw.ntfy) as Reminder[] | undefined) ?? [],
      retry_count: Number(raw.retry_count) || 0,
      section: (raw.section ?? "") as Section,
      title: raw.title ?? "",
    };
    const seen = run.asanaSeen.get(stored.asana_gid);
    const asanaState =
      (seen === "completed" && stored.asana_written?.completed
        ? undefined
        : HAND_CHANGES.get(`${stored.asana_state}/${seen ?? ""}`)) ?? stored.asana_state;
    this.skipped = course === undefined;
    this.item = course && assignment?.inScope ? new Item(assignment, course, run.now) : undefined;
    const lifecycle = this.item?.lifecycle ?? (course ? "gone" : stored.lifecycle);
    this.key = key;
    this.now = run.now;
    this.stored = stored;
    this.wanted = new Set(course ? WANTS.get(`${lifecycle}/${asanaState}`) : []);
    const [courseId, assignmentId] = key.split(":").map(Number);
    this.plan = {
      drop: false,
      key,
      previousAsanaState: stored.asana_state,
      previousLifecycle: stored.lifecycle,
      row: {
        ...stored,
        asana_state: asanaState,
        assignment_id: assignmentId,
        canvas_key: key,
        course_id: courseId,
        gone_since: course ? undefined : stored.gone_since,
        item_fp: assignment?.fingerprint ?? stored.item_fp,
        lifecycle,
        title: assignment?.name ?? stored.title,
      },
    };
  }

  actions(): RowAction[] {
    const { item, now, plan, stored, wanted } = this;
    const task = new TaskPlanner(this);
    const event = new EventPlanner(this);
    if (this.skipped) {
      return CONFIG.ntfy.enabled
        ? stored.ntfy
            .filter((reminder) => Temporal.Instant.compare(reminder.at, now) > 0)
            .map((reminder) => cancelReminder(reminder.id))
        : [];
    }
    if (!item) {
      plan.row.gone_since = stored.gone_since ?? now;
      const confirmAt = Temporal.Instant.from(plan.row.gone_since).add(GONE_CONFIRM);
      plan.drop = Temporal.Instant.compare(now, confirmAt) >= 0;
      plan.row.wake_at = plan.drop ? undefined : confirmAt.toString(); // the confirming full read
      if (!plan.drop) return [];
      return [
        ...task.delete(),
        ...event.delete(),
        ...(CONFIG.ntfy.enabled ? stored.ntfy.map((reminder) => cancelReminder(reminder.id)) : []),
      ];
    }
    const lockAt = item.assignment.lock_at;
    const reminders = CONFIG.ntfy.enabled ? new ReminderPlanner(this, item) : undefined;
    plan.row.ntfy = reminders?.pending ?? stored.ntfy;
    plan.row.wake_at = [
      ...(wanted.has("event") && lockAt && Temporal.Instant.compare(lockAt, now) > 0
        ? [Temporal.Instant.from(lockAt).add(LOCK_GRACE)]
        : []),
      ...(reminders?.wakes() ?? []),
      ...task.wakes(item),
    ]
      .toSorted((first, second) => Temporal.Instant.compare(first, second))
      .at(0)
      ?.toString();
    return [
      ...task.create(item),
      ...task.update(item),
      ...task.moveSection(item),
      ...event.insert(item),
      ...event.update(item),
      ...event.delete(),
      ...(reminders?.schedule() ?? []),
      ...(reminders?.cancelUnwanted() ?? []),
    ];
  }
}

class RunPlan {
  readonly #actions: Action[] = [];
  readonly #counts: PlanSummary["counts"] = { asana: 0, gcal: 0, ntfy: 0 };
  readonly #cut: string[] = [];
  readonly #plans: Plan[] = [];

  add(plan: Plan, actions: RowAction[]): void {
    const byTarget = Map.groupBy(actions, (action) => action.target);
    if (
      TARGETS.some(
        (target) =>
          this.#counts[target] + (byTarget.get(target)?.length ?? 0) >
          CONFIG.max_actions_per_destination,
      )
    ) {
      this.#cut.push(plan.key);
      return;
    }
    for (const [target, targetActions] of byTarget) this.#counts[target] += targetActions.length;
    this.#actions.push(
      ...actions.map((action, index) => ({
        ...action,
        index,
        key: plan.key,
        planIndex: this.#plans.length,
      })),
    );
    this.#plans.push(plan);
  }

  items(): N8nItem<Action | PlanSummary>[] {
    return [
      ...this.#actions,
      {
        counts: this.#counts,
        cut: this.#cut,
        plans: this.#plans,
        route: "none" as const,
      },
    ].map((json) => ({ json }));
  }
}

class TaskPlanner {
  readonly #row: Row;

  constructor(row: Row) {
    this.#row = row;
  }

  create(item: Item): RowAction[] {
    const { key, stored, wanted } = this.#row;
    if (!wanted.has("createTask")) return [];
    const section = item.section(stored.section);
    const externalId = `canvas-${key.replace(":", "-")}`;
    const task = this.#task(item);
    return [
      {
        body: {
          data: {
            custom_fields: changedCustomFields(task),
            external: { gid: externalId },
            memberships: [{ project: CONFIG.asana.project, section: item.sectionGid(section) }],
            name: item.assignment.name,
            notes: item.notes,
            projects: [CONFIG.asana.project],
            tags: item.course.tag ? [item.course.tag] : [],
            ...item.due.asana,
          },
        },
        kind: "createTask",
        lookupUrl: asanaUrl(
          `/tasks/external:${externalId}?${new URLSearchParams({ opt_fields: "gid,completed" }).toString()}`,
        ),
        method: "POST",
        patch: { asana_state: "live", asana_written: task, section },
        route: "asanaCreate",
        target: "asana",
        url: asanaUrl("/tasks"),
      },
    ];
  }

  delete(): RowAction[] {
    const { stored, wanted } = this.#row;
    if (!wanted.has("deleteTask") || !stored.asana_gid) return [];
    return [
      {
        kind: "deleteTask",
        method: "DELETE",
        patch: { asana_gid: "", asana_state: "none" },
        route: "asanaDelete",
        target: "asana",
        url: asanaUrl(`/tasks/${stored.asana_gid}`),
      },
    ];
  }

  moveSection(item: Item): RowAction[] {
    const { stored, wanted } = this.#row;
    const section = item.section(stored.section);
    if (!wanted.has("taskWrites") || !stored.asana_gid || stored.section === section) return [];
    return [
      {
        body: { data: { task: stored.asana_gid } },
        kind: "moveSection",
        method: "POST",
        patch: { section },
        route: "asanaWrite",
        target: "asana",
        url: asanaUrl(`/sections/${item.sectionGid(section)}/addTask`),
      },
    ];
  }

  update(item: Item): RowAction[] {
    const { stored, wanted } = this.#row;
    if (!wanted.has("taskWrites") || !stored.asana_gid) return [];
    const written = stored.asana_written;
    const task = this.#task(item);
    const fields = new Map<string, boolean | null | Record<string, string> | string>();
    if (written?.name !== task.name) fields.set("name", task.name);
    if (written?.notesHash !== task.notesHash) fields.set("notes", item.notes);
    if (!isDeepStrictEqual(written?.due, task.due)) {
      for (const field of ASANA_DATES) {
        if (written?.due[field] ?? task.due[field]) {
          // oxlint-disable-next-line unicorn/no-null -- Asana clears a date field only for null, and undefined would be dropped from the JSON body and leave the old date set.
          fields.set(field, task.due[field] ?? null);
        }
      }
    }
    if (Boolean(written?.completed) !== task.completed) fields.set("completed", task.completed);
    const customFields = changedCustomFields(task, written);
    if (Object.keys(customFields).length > 0) fields.set("custom_fields", customFields);
    if (fields.size === 0) return [];
    return [
      {
        body: { data: Object.fromEntries(fields) },
        kind: fields.get("completed") === true ? "completeTask" : "updateTask",
        method: "PUT",
        patch: { asana_written: task },
        route: "asanaWrite",
        target: "asana",
        url: asanaUrl(`/tasks/${stored.asana_gid}`),
      },
    ];
  }

  wakes(item: Item): Temporal.Instant[] {
    const { now, wanted } = this.#row;
    if (!wanted.has("priority")) return [];
    return PRIORITY_STEPS.map(([most]) =>
      item.due.date.subtract({ days: most }).toZonedDateTime(ZONE).toInstant(),
    ).filter((at) => Temporal.Instant.compare(at, now) > 0);
  }

  #task(item: Item): AsanaTask {
    const { now, stored } = this.#row;
    const written = stored.asana_written;
    switch (item.lifecycle) {
      case "done": {
        return {
          ...item.task,
          priority: written?.priority ?? "none",
          status: "done",
        };
      }
      case "missed": {
        return { ...item.task, priority: "none", status: "missed" };
      }
      case "open": {
        const today = Temporal.Instant.from(now).toZonedDateTimeISO(ZONE).toPlainDate();
        const daysLeft = today.until(item.due.date).days;
        const priority = PRIORITY_STEPS.find(([most]) => daysLeft <= most)?.[1] ?? "low";
        return { ...item.task, priority, status: "todo" };
      }
    }
  }
}

export default function plan(): N8nItem<Action | PlanSummary>[] {
  const { order } = $<{ order: Order }>("From check").first().json;
  const rows = new Map(
    $<RawLedgerRow>("Read ledger")
      .all()
      .filter((item) => item.json.canvas_key)
      .map((item) => [item.json.canvas_key, item.json]),
  );
  const snapshotItems = new Map(
    order.snapshots
      .flatMap((snapshot) => snapshot.items)
      .map((item) => [[item.course_id, item.id].join(":"), item]),
  );
  const configured = new Map(CONFIG.courses);
  const refused = new Set(
    order.snapshots.filter((snapshot) => snapshot.refused).map((snapshot) => snapshot.courseId),
  );
  const courses = new Map(
    CONFIG.courses.filter(([courseId]) =>
      order.snapshots.some((snapshot) => snapshot.complete && snapshot.courseId === courseId),
    ),
  );
  const run = { asanaSeen: new Map(order.asanaSeen), now: order.now };
  const runPlan = new RunPlan();
  for (const key of new Set([...rows.keys(), ...snapshotItems.keys()])) {
    const courseId = Number(key.split(":")[0]);
    const course = courses.get(courseId);
    const assignment = snapshotItems.get(key);
    if (
      configured.has(courseId) &&
      !refused.has(courseId) &&
      (!course || !(assignment?.inScope || rows.has(key)))
    )
      continue;
    const row = new Row(key, rows.get(key) ?? {}, assignment, course, run);
    runPlan.add(row.plan, row.actions());
  }
  return runPlan.items();
}

function asanaUrl(path: string): string {
  return new URL(`${ASANA_API}${path}`).href;
}

function cancelReminder(id: string): RowAction {
  return {
    kind: "cancel",
    method: "DELETE",
    patch: { ntfyRemove: id },
    route: "ntfyCancel",
    target: "ntfy",
    url: `${CONFIG.ntfy.base_url}/${CONFIG.ntfy.topic}/${id}`,
  };
}

function changedCustomFields(task: AsanaTask, written?: AsanaWritten): Record<string, string> {
  const { priority, status } = CONFIG.asana.fields;
  return {
    ...(task.priority !== written?.priority && {
      [priority.gid]: priority.options[task.priority],
    }),
    ...(task.status !== written?.status && { [status.gid]: status.options[task.status] }),
  };
}

function eventId(key: string): string {
  return "cv" + key.replace(":", "a");
}

function gcalUrl(id = ""): string {
  return new URL(id ? `${EVENTS_URL}/${id}` : EVENTS_URL).href;
}

function parseJson(text: TextCell | undefined): unknown {
  if (!text) return;
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}
