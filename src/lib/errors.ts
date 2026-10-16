// Error types: validation (caller's fault, 4xx) vs system (ours or a dependency's, 5xx).

export class ValidationError extends Error {
  readonly kind = "validation" as const;
  constructor(
    message: string,
    readonly status = 400,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class SystemError extends Error {
  readonly kind = "system" as const;
  constructor(
    message: string,
    readonly status = 500,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string, data: Record<string, unknown> = {}) =>
  new ValidationError(`${what} not found`, 404, data);
