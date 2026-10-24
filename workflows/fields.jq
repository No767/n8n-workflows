def field($name; $options):
  (first(.data[].custom_field | select(.name == $name))
    // error("the Asana project has no \($name) field")) as $field
  | {
    gid: $field.gid,
    options: $options | map_values(
      . as $option
      | first($field.enum_options[]? | select(.name == $option)).gid
        // error("the \($name) field has no \"\($option)\" option"))
  };

{
  priority: field("Priority"; {critical: "Critical", high: "High", medium: "Medium", low: "Low", none: "None"}),
  status: field("Status"; {done: "Done", missed: "Missed", todo: "Todo"})
}
