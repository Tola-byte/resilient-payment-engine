export type TransferStatus =
  | "pending"
  | "uncertain"
  | "succeeded"
  | "failed"
  | "reversed";

export type FundsState = "reserved" | "captured" | "released";

export interface TransferInput {
  debitAccountId: string;
  destinationAccount: string;
  amount: number;
}

export interface PublicTransfer extends TransferInput {
  id: string;
  status: TransferStatus;
  providerReference: string | null;
  failureReason: string | null;
  needsReconciliation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderTransferRequest {
  clientReference: string;
  destinationAccount: string;
  amount: number;
}

export interface ProviderTransferResult {
  providerReference: string;
  status: "accepted" | "rejected";
}

export interface ProviderStatusResult {
  status: "pending" | "succeeded" | "failed";
}

export interface TransferProvider {
  send(request: ProviderTransferRequest): Promise<ProviderTransferResult>;
  // Adapters must accept either their acknowledged reference or the stable
  // clientReference when send's response was lost.
  getStatus(lookupReference: string): Promise<ProviderStatusResult>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
