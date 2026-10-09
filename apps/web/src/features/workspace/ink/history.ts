// Undo / redo per document (spec §26). A command is a list of item state changes (before → after;
// null = absent/tombstoned), so create, delete, move, recolor, resize, split (point eraser) and
// shape enhancement all undo the same way. History lives in memory for the lifetime of the open
// app: it survives switching tabs/panels while the app is open, but NOT a reload — after a reload
// the strokes are all still there (IndexedDB) and the history starts fresh. The toolbar says so.
import type { InkItem } from './model';

export interface ItemChange {
  id: string;
  /** page the item lives on (annotationTargetKey of its anchor) */
  targetKey: string;
  before: InkItem | null;
  after: InkItem | null;
}

export interface Command {
  label_ar: string;
  changes: ItemChange[];
}

export function invertChanges(changes: readonly ItemChange[]): ItemChange[] {
  return changes
    .slice()
    .reverse()
    .map((c) => ({ id: c.id, targetKey: c.targetKey, before: c.after, after: c.before }));
}

export class InkHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly limit = 200) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label_ar ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label_ar ?? null;
  }
  get size(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
  /** changes every time the stacks change (for useSyncExternalStore) */
  getVersion = (): number => this.version;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  push(cmd: Command): void {
    const changes = cmd.changes.filter((c) => c.before !== c.after);
    if (changes.length === 0) return;
    this.undoStack.push({ ...cmd, changes });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  /** Merge into the last command (one undo step for a whole gesture). */
  amendLast(changes: readonly ItemChange[]): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (!last) return;
    for (const c of changes) {
      const prev = last.changes.find((x) => x.id === c.id);
      if (prev) prev.after = c.after;
      else last.changes.push({ ...c });
    }
    this.emit();
  }

  /** Pops the last command and returns the changes that revert it. */
  undo(): ItemChange[] | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.redoStack.push(cmd);
    this.emit();
    return invertChanges(cmd.changes);
  }

  /** Re-applies the last undone command. */
  redo(): ItemChange[] | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this.undoStack.push(cmd);
    this.emit();
    return cmd.changes.map((c) => ({ ...c }));
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }
}
