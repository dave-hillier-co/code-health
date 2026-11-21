export const handlers = new Map<string, () => void>();

export function register(name: string, handler: () => void): void {
  handlers.set(name, handler);
}
