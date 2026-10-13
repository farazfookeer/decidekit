/**
 * Short descriptions of parsed YAML values for error messages, shared by the
 * question set and labelled examples validators.
 */

/** Describes a value's type and content, for example `string "yes"` or `a list`. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  // JSON.stringify turns Infinity and NaN into "null", which is misleading.
  if (typeof value === "number" && !Number.isFinite(value)) return `number ${String(value)}`;
  return typeof value === "object" ? "a mapping" : `${typeof value} ${JSON.stringify(value)}`;
}
