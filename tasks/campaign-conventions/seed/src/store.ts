import type { Note } from "./note";

/**
 * An in-memory notes store. Each note is keyed by its title (supplied by the
 * caller), so the store itself never generates identifiers.
 */
export class NoteStore {
  private readonly notes = new Map<string, Note>();

  /** Insert or overwrite the note held under this title. */
  add(note: Note): void {
    this.notes.set(note.title, note);
  }

  /** Look up a note by its title. */
  get(title: string): Note | undefined {
    return this.notes.get(title);
  }

  /** Every note currently in the store, in insertion order. */
  all(): Note[] {
    return [...this.notes.values()];
  }
}
