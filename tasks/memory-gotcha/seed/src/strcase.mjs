// String-case helpers. Pure functions, no dependencies.

export function toKebab(input) {
  return String(input)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function toSnake(input) {
  return toKebab(input).replace(/-/g, "_");
}
