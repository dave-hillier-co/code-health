/**
 * The default time budget of the post-edit hook in milliseconds, which covers process start, the worker,
 * reading the file and the file at HEAD. Claude Code waits for the hook, so a run that has not finished
 * by then prints nothing. The lexical layer is used because loading the WASM runtime and a grammar alone
 * takes about as long.
 */
export const DEFAULT_BUDGET_MS = 150;
