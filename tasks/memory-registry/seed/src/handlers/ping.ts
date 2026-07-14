import type { Handler } from "../handler";

/** Replies to a liveness check. A handler is just a pure function. */
export const ping: Handler = (_arg: string): string => "pong";
