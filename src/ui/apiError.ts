/** A failed call to the local server: its status, its error code and the code's parameters. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
  }
}
