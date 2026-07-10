let seq = 0;

/** Mint a short opaque handle. */
export function newId(): string {
  seq += 1;
  return `id_${seq.toString(36)}`;
}
