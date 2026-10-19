// The meaning depends on what the URL names: a 404 on PUT /tasks/{gid} is about the task, but a
// 404 on POST /sections/{gid}/addTask is about the section.
//   ok        the action did what it was planned to do
//   adopted   createTask found our task already in Asana (a run crashed before Commit saved its gid)
//   taskGone  the task was deleted by hand; the row becomes hand_deleted
// A status that isn't listed is a failure: the row keeps its old state, records last_error and retries.
// Seen on n8n-local: lookup 404 (no such task), Asana create 201, Asana write 200, Asana delete 200,
// Calendar insert/patch 200, Calendar delete 204, ntfy schedule 200, ntfy cancel 200. ntfy answers a
// cancel with 200 even when no message has that id, so there's no 404 to accept.
const OUTCOMES: Record<ActionKind, Partial<Record<number, Outcome>>> = {
  cancel: { 200: "ok" },
  completeTask: { 200: "ok", 404: "taskGone" },
  createTask: { 200: "adopted", 201: "ok" }, // 200 comes from Asana lookup, 201 from Asana create
  deleteEvent: { 204: "ok", 404: "ok", 410: "ok" },
  deleteTask: { 200: "ok", 404: "ok" }, // already gone is the goal
  insertEvent: { 200: "ok" }, // a 409 goes to Calendar revive, which answers 200
  moveSection: { 200: "ok" },
  patchEvent: { 200: "ok" },
  schedule: { 200: "ok" },
  updateTask: { 200: "ok", 404: "taskGone" },
};

export default function pairResult(): N8nItem<ActionResult | PlanSummary> {
  const action = $<Action | PlanSummary>("Loop").item.json;
  if ("plans" in action) return { json: action };

  const { index, key, kind, method, patch, planIndex, target, url } = action;
  const record = { index, key, kind, method, patch, planIndex, target, url };

  const status = $json.statusCode;
  const outcome = OUTCOMES[kind][status ?? 0] ?? "fail";
  const result: ActionResult = { action: record, gid: $json.body?.data?.gid, outcome, status };
  if (outcome !== "fail") return { json: result };
  const reason = typeof $json.error === "string" ? $json.error : $json.error?.message;
  return {
    json: {
      ...result,
      error: `${String(status ?? "error")} ${($json.body ? JSON.stringify($json.body) : (reason ?? "no response")).slice(0, 300)}`,
    },
  };
}
