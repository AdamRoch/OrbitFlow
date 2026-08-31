/** Shared application validation error mapped at the HTTP boundary. */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
