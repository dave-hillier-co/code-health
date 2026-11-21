export interface Clock {
  now(): number;
}

export abstract class Repository {
  abstract find(id: string): string;
}

export class SystemClock implements Clock {
  now(): number {
    return 0;
  }
}

export enum Level {
  Low,
  High,
}

export function describe(level: Level): string {
  return String(level);
}
