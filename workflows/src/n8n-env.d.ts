interface Action {
  body?: unknown;
  index: number;
  key: string;
  kind: ActionKind;
  lookupUrl?: string;
  method: string;
  patch: ActionPatch;
  planIndex: number;
  reviveBody?: unknown;
  reviveUrl?: string;
  route: string;
  target: "asana" | "gcal" | "ntfy";
  url: string;
}

type ActionKind =
  | "cancel"
  | "completeTask"
  | "createTask"
  | "deleteEvent"
  | "deleteTask"
  | "insertEvent"
  | "moveSection"
  | "patchEvent"
  | "schedule"
  | "updateTask";

type ActionPatch = Partial<PlannedRow> & { ntfyAdd?: Reminder; ntfyRemove?: string };

interface ActionResult {
  action: Pick<
    Action,
    "index" | "key" | "kind" | "method" | "patch" | "planIndex" | "target" | "url"
  >;
  error?: string;
  gid?: string;
  outcome: Outcome;
  status?: number;
}

type AsanaDates = Partial<Record<"due_at" | "due_on" | "start_at" | "start_on", string>>;

interface AsanaEvent {
  action: string;
  change?: { field?: string };
  resource?: { gid: string; resource_type: string };
}

interface AsanaPage<T> {
  data?: T[];
  next_page?: null | { uri: string };
  sync?: string;
}

type AsanaState = "hand_completed" | "hand_deleted" | "live" | "none";

interface AsanaWritten {
  completed: boolean;
  due: AsanaDates;
  name: string;
  notesHash: string;
}

interface CalendarEvent {
  description: string;
  end: Record<string, string>;
  start: Record<string, string>;
  summary: string;
}

interface CanvasAssignment {
  course_id: number;
  description: null | string;
  due_at: null | string;
  html_url: string;
  id: number;
  lock_at: null | string;
  name: string;
  published?: boolean;
  submission?: CanvasSubmission;
  submission_types: string[];
  unlock_at: null | string;
}

interface CanvasSubmission {
  excused?: boolean | null;
  missing?: boolean | null;
  submitted_at?: null | string;
  workflow_state?: null | string;
}

interface Config {
  asana: { missed_section: string; project: string; start_dates: boolean };
  calendar: { id: string };
  canvas: { base_url: string };
  canvas_min_remaining: number;
  courses: [number, CourseConfig][];
  ignore_items: number[];
  lease_minutes: number;
  max_actions_per_destination: number;
  ntfy: { alert_topic: string; base_url: string; enabled: boolean; topic: string };
}

interface CourseConfig {
  label: string;
  match?: { pattern: string; section: string };
  section: string;
  tag: string;
}

interface CourseItem {
  courseId: number;
  gate: GateSummary;
  url: string;
}

interface GateSummary {
  asanaSync: string;
  canvasLog: RateLogEntry[];
  idleRows: MetaRow[];
  plannerChanged: boolean;
  plannerFingerprint?: string;
}

interface HttpResponse<Body> {
  body?: Body;
  error?: string | { message?: string };
  headers?: Record<string, string | undefined>;
  statusCode?: number;
}

type Lifecycle = "done" | "gone" | "missed" | "none" | "open";

interface MetaRow {
  key: string;
  owner: string;
  until: string;
  value: string;
}

interface N8nItem<T> {
  json: T;
}

interface N8nNode<T> {
  all(branchIndex?: number, runIndex?: number): N8nItem<T>[];
  first(): N8nItem<T>;
  readonly isExecuted: boolean;
  readonly item: N8nItem<T>;
  last(): N8nItem<T>;
}

type NumberCell = null | number | string;

interface Order {
  asanaSeen?: [string, TaskSeen][];
  asanaSync: string;
  canvasLog: RateLogEntry[];
  fullFingerprint: string;
  now: string;
  plannerFingerprint?: string;
  reasons: string[];
  snapshots: Snapshot[];
}

type Outcome = "adopted" | "fail" | "ok" | "taskGone";

interface Plan {
  drop: boolean;
  key: string;
  previousAsanaState: string;
  previousLifecycle: string;
  row: PlannedRow;
}

interface PlannedRow {
  asana_gid: string;
  asana_state: AsanaState;
  asana_written?: AsanaWritten;
  assignment_id: number;
  canvas_key: string;
  course_id: number;
  gcal_state: "live" | "none";
  gcal_written?: CalendarEvent;
  gone_since?: string;
  item_fp: string;
  last_error?: string;
  lifecycle: Lifecycle;
  ntfy: Reminder[];
  retry_count: number;
  section: Section;
  title: string;
  wake_at?: string;
}

interface PlannerItem {
  course_id: number;
  plannable: {
    assignment_id?: number;
    due_at?: null | string;
    id: number;
    lock_at?: null | string;
    title: string;
  };
  plannable_type: string;
  submissions?:
    | false
    | { excused?: boolean; graded?: boolean; missing?: boolean; submitted?: boolean };
}

interface PlanSummary {
  counts: Record<Action["target"], number>;
  cut: string[];
  plans: Plan[];
  route: "none";
}

interface RateLogEntry {
  call: string;
  cost?: number;
  remaining?: number;
  status?: number;
}

interface RawLedgerRow {
  asana_gid?: TextCell;
  asana_state?: TextCell;
  asana_written?: TextCell;
  assignment_id?: NumberCell;
  canvas_key: string;
  course_id?: NumberCell;
  gcal_state?: TextCell;
  gcal_written?: TextCell;
  gone_since?: TextCell;
  item_fp?: TextCell;
  last_error?: TextCell;
  lifecycle?: TextCell;
  ntfy?: TextCell;
  retry_count?: NumberCell;
  section?: TextCell;
  title?: TextCell;
  wake_at?: TextCell;
}

interface Reminder {
  at: string;
  id: string;
}

type Section = "" | "class" | "matched" | "missed";

interface Snapshot {
  complete: boolean;
  courseId: number;
  items: SnapshotItem[];
  refused: boolean;
}

interface SnapshotItem {
  course_id: number;
  description: string;
  due_at?: string;
  fingerprint: string;
  html_url: string;
  id: number;
  inScope: boolean;
  lock_at?: string;
  name: string;
  submission: {
    excused?: boolean;
    missing?: boolean;
    submitted_at?: string;
    workflow_state?: string;
  };
  submission_types: string[];
  unlock_at?: string;
}

interface StartOutput {
  leaseMinutes: number;
  manual: boolean;
  now: string;
  stored: {
    asanaSync: string;
    asanaSyncSavedAt?: string;
    fullFingerprint?: string;
    plannerFingerprint?: string;
  };
  tick: "full" | "planner";
  urls: {
    asanaEvents: string;
    asanaTasks: string;
    courses: { courseId: number; url: string }[];
    planner: string;
  };
  wakeKeys: string[];
  watched: Watched[];
}

type TaskSeen = "absent" | "completed" | "open";

type TextCell = null | string;

interface Watched {
  completed: boolean;
  gid: string;
}

declare function $<T>(nodeName: string): N8nNode<T>;
declare const $json: HttpResponse<{ data?: { gid?: string } }>;
declare const CONFIG: Config;
