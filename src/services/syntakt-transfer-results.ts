import type { BankTransferResult } from './syntakt-transfer.js';

export interface SyntaktTransferResultSummary {
  successful: boolean;
  verified: boolean;
}

/** A completed write without optional readback is a success, not an error. */
export function classifySyntaktTransferResults(results: readonly BankTransferResult[]): SyntaktTransferResultSummary {
  const successful = results.length > 0 && results.every((result) => result.state === 'verified' || result.state === 'written');
  return { successful, verified: successful && results.every((result) => result.state === 'verified') };
}
