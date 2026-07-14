import { registry } from "./registry";

/**
 * Route a command to its handler by name. Only handlers listed in the registry
 * are reachable here; an unregistered handler simply cannot be dispatched by
 * name (though it still works when imported and called directly).
 */
export function dispatch(command: string, arg: string): string {
  const handler = registry[command];
  if (!handler) {
    throw new Error(`unknown command: ${command}`);
  }
  return handler(arg);
}
