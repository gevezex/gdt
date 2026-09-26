/**
 * Terminal backend interface (design 9.6). A pane is a named slot that runs one gdt process and shows
 * a title; panes outlive the process that created them. A handle is the gdt process id.
 */
export interface Backend {
  /** Creates the workflow workspace if needed and ensures its named panes exist. */
  ensureWorkspace(): void;
  /** Starts `argv` as the pane named `name`; returns the gdt process id. */
  spawnPane(name: string, argv: readonly string[]): number;
  /** Sets the visible title of the named pane; a no-op for backends without titles. */
  setTitle(name: string, title: string): void;
  alive(handle: number): boolean;
  /** Stops the pane's gdt process, keeping the pane itself. */
  close(handle: number): void;
  /** Command a human runs to attach to the workflow's terminal, or null when there is none. */
  attach(): string | null;
}
