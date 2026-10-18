($ENV.MERGED_CONFIG | fromjson | .ntfy += {
  alert_url: "\(.ntfy.base_url)/\(.ntfy.alert_topic)",
  nodes_disabled: (.ntfy.enabled | not)
}) as $config
| walk(
  if type == "string" and startswith("@config ") then
    (ltrimstr("@config ") | split(".")) as $path
    | $config | getpath($path)
    | if . == null then error("the config has no \($path | join("."))") else . end
  elif type == "string" and startswith("@code ") then
    ltrimstr("@code ") as $name
    | ($ARGS.named[$name] // error("no \($name).ts for this node"))
    | (capture("(?m)^export default function (?<name>[\\w$]+)").name
      // error("\($name).ts has no export default function")) as $entry
    | "const CONFIG = \($ENV.WORKFLOW_NODE_CONFIG);\n\n"
      + gsub("(?m)^import (?<names>.+) from \"node:(?<module>[a-z]+)\";$"; "const \(.names) = require('\(.module)');")
      + "\nreturn \($entry)();\n"
    | sub("(?m)^export default function "; "function ")
    | if test("(?m)^(import|export)\\b") then
        error("\($name).ts: only `import … from \"node:<built-in>\"` and one `export default function` are supported")
      else . end
  else . end)
