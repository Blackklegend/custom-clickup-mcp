import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ToolFailure } from '../errors.js';

interface ConfirmationClaims {
  action: string;
  subject: string;
  payloadHash: string;
  expiresAt: number;
  nonce: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(payload))).digest('base64url');
}

export class ConfirmationService {
  readonly #secret = randomBytes(32);
  /** Consumed signature -> the claim's `expiresAt`, so spent tokens can be dropped once
   * the expiry check would reject them anyway. */
  readonly #consumed = new Map<string, number>();

  #forgetExpired(): void {
    const now = Date.now();
    for (const [signature, expiresAt] of this.#consumed) {
      if (expiresAt <= now) this.#consumed.delete(signature);
    }
  }

  create(action: string, subject: string, payload: unknown, ttlMs = 10 * 60_000): string {
    const claims: ConfirmationClaims = {
      action,
      subject,
      payloadHash: payloadHash(payload),
      expiresAt: Date.now() + ttlMs,
      nonce: randomBytes(12).toString('base64url'),
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', this.#secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  verifyAndConsume(
    token: string,
    action: string,
    subject: string,
    payload: unknown,
  ): void {
    const [encoded, signature, extra] = token.split('.');
    if (encoded === undefined || signature === undefined || extra !== undefined) {
      throw new ToolFailure('CONFIRMATION_INVALID', 'The confirmation token is invalid.', false);
    }
    this.#forgetExpired();
    if (this.#consumed.has(signature)) {
      throw new ToolFailure('CONFIRMATION_CONSUMED', 'The confirmation token was already used.', false);
    }
    const expected = createHmac('sha256', this.#secret).update(encoded).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, 'base64url');
    } catch {
      throw new ToolFailure('CONFIRMATION_INVALID', 'The confirmation token is invalid.', false);
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ToolFailure('CONFIRMATION_INVALID', 'The confirmation token is invalid.', false);
    }

    let claims: ConfirmationClaims;
    try {
      claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ConfirmationClaims;
    } catch {
      throw new ToolFailure('CONFIRMATION_INVALID', 'The confirmation token is invalid.', false);
    }
    if (
      claims.action !== action ||
      claims.subject !== subject ||
      claims.payloadHash !== payloadHash(payload)
    ) {
      throw new ToolFailure(
        'CONFIRMATION_MISMATCH',
        'The confirmation token does not match this operation.',
        false,
      );
    }
    if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= Date.now()) {
      throw new ToolFailure('CONFIRMATION_EXPIRED', 'The confirmation token has expired.', false);
    }
    this.#consumed.set(signature, claims.expiresAt);
  }
}
