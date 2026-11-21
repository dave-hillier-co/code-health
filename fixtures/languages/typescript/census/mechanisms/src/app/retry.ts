export function retry(task: () => void): void {
  task();
}
