// Typed PayPal errors, surfaced in the UI and the audit log. Never carries credentials or tokens.

export interface PayPalIssue {
  issue: string;
  description?: string;
  field?: string;
}

export class PayPalError extends Error {
  readonly status: number;
  readonly paypalName: string;
  readonly debugId: string | null;
  readonly issues: PayPalIssue[];
  readonly retryable: boolean;
  readonly operation: string;

  constructor(opts: {
    operation: string;
    status: number;
    name?: string;
    message?: string;
    debugId?: string | null;
    issues?: PayPalIssue[];
  }) {
    const issueText = opts.issues?.length ? ` [${opts.issues.map((i) => i.issue).join(', ')}]` : '';
    super(`PayPal ${opts.operation} failed (${opts.status} ${opts.name ?? 'ERROR'}): ${opts.message ?? 'no message'}${issueText}`);
    this.name = 'PayPalError';
    this.operation = opts.operation;
    this.status = opts.status;
    this.paypalName = opts.name ?? 'ERROR';
    this.debugId = opts.debugId ?? null;
    this.issues = opts.issues ?? [];
    this.retryable = opts.status === 429 || opts.status >= 500;
  }

  toJSON() {
    return {
      operation: this.operation,
      status: this.status,
      name: this.paypalName,
      message: this.message,
      debugId: this.debugId,
      issues: this.issues,
    };
  }
}

export class PayPalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayPalConfigError';
  }
}
