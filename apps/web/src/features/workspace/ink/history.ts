// Undo / redo per document (spec §26). A command is a list of item state changes (before → after;
// null = absent/tombstoned), so create, delete, move, recolor, resize, split (point eraser) and
// shape enhancement all undo the same way. The stacks live in memory while the document is open and
// (Round 7 — H3 item 1) are also kept as a size-capped command log in IndexedDB (historyLog.ts), so the
// history survives a reload or closing the app. Applying a step is the store's job (store.ts): it
// checks first that the step's items are still as the step left them.
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

  /** The step `undo()` / `redo()` would apply next (not removed). */
  peekUndo(): Command | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }
  peekRedo(): Command | null {
    return this.redoStack[this.redoStack.length - 1] ?? null;
  }

  /** (H3) Removes the next undo / redo step WITHOUT applying it (the owner chose to skip it). */
  drop(dir: 'undo' | 'redo'): void {
    const stack = dir === 'undo' ? this.undoStack : this.redoStack;
    if (stack.pop()) this.emit();
  }

  /**
   * (H3 review) The step that undo() / redo() just moved onto `stack` keeps only the changes `keep` accepts — the part
   * that was really applied. A change skipped because the item was already as the step wanted it (e.g. a stroke erased
   * on another device, so undoing its «كتابة» had nothing to remove) must not come back with the opposite step: redo
   * would otherwise bring the erased stroke back without asking. A step left with no change leaves the stack.
   */
  narrowTop(stack: 'undo' | 'redo', keep: (c: ItemChange) => boolean): void {
    const s = stack === 'undo' ? this.undoStack : this.redoStack;
    const top = s[s.length - 1];
    if (!top) return;
    const changes = top.changes.filter(keep);
    if (changes.length === top.changes.length) return;
    if (changes.length === 0) s.pop();
    else s[s.length - 1] = { ...top, changes };
    this.emit();
  }

  /** (H3) Both stacks, oldest first (for the command log). */
  snapshot(): { undo: Command[]; redo: Command[] } {
    return { undo: this.undoStack.slice(), redo: this.redoStack.slice() };
  }

  /**
   * (H3) The command log restored after a reload. Steps made in this session before the log arrived stay on top of
   * the restored ones; a new step clears redo, so the restored redo steps are kept only if none was made.
   */
  restore(undo: readonly Command[], redo: readonly Command[]): void {
    if (undo.length === 0 && redo.length === 0) return;
    const fresh = this.undoStack.length === 0 && this.redoStack.length === 0;
    this.undoStack = [...undo, ...this.undoStack].slice(-this.limit);
    if (fresh) this.redoStack = redo.slice(-this.limit);
    this.emit();
  }
}
