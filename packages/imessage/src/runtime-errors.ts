/** An operation unavailable in the Workers HTTP transport (never silently skipped). */
export class WorkersCapabilityError extends Error {
  constructor(operation: string, detail: string) {
    super(`${operation}: ${detail}`);
    this.name = 'WorkersCapabilityError';
  }
}
