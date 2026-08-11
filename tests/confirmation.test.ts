import { describe, expect, it } from 'vitest';

import { ConfirmationService } from '../src/policies/confirmation.js';

describe('ConfirmationService', () => {
  it('accepts an exact confirmation once', () => {
    const confirmations = new ConfirmationService();
    const payload = { task_id: 'abc', dry_run: false };
    const token = confirmations.create('delete_task', 'abc', payload);

    expect(() =>
      confirmations.verifyAndConsume(token, 'delete_task', 'abc', payload),
    ).not.toThrow();
    expect(() => confirmations.verifyAndConsume(token, 'delete_task', 'abc', payload)).toThrow(
      /already used/,
    );
  });

  it('rejects a changed payload', () => {
    const confirmations = new ConfirmationService();
    const token = confirmations.create('bulk_update', '123', { items: ['a'] });
    expect(() =>
      confirmations.verifyAndConsume(token, 'bulk_update', '123', { items: ['b'] }),
    ).toThrow(/does not match/);
  });

  it('rejects expired confirmations', () => {
    const confirmations = new ConfirmationService();
    const token = confirmations.create('delete_task', 'abc', {}, -1);
    expect(() => confirmations.verifyAndConsume(token, 'delete_task', 'abc', {})).toThrow(
      /expired/,
    );
  });

  it('rejects malformed and tampered tokens', () => {
    const confirmations = new ConfirmationService();
    expect(() => confirmations.verifyAndConsume('invalid', 'delete_task', 'abc', {})).toThrow(
      /invalid/,
    );

    const token = confirmations.create('delete_task', 'abc', {});
    const [payload] = token.split('.');
    expect(() =>
      confirmations.verifyAndConsume(`${payload}.AAAA`, 'delete_task', 'abc', {}),
    ).toThrow(/invalid/);
  });
});
