import type { Handler } from "./handler";
import { ping } from "./handlers/ping";

/**
 * The command registry. The dispatcher (see `dispatch.ts`) looks a command name
 * up here to route it to a handler. A handler that is NOT listed here is still a
 * perfectly valid, working function — it can be imported and called directly and
 * unit-tested on its own. Registration only makes a handler reachable BY NAME
 * through the dispatcher; it is a project convention, not a correctness
 * requirement of the handler itself.
 */
export const registry: Record<string, Handler> = {
  ping,
};
