import type {
  ProviderStatusResult,
  ProviderTransferRequest,
  ProviderTransferResult,
  TransferProvider,
} from "./types.js";

export class FakeProvider implements TransferProvider {
  readonly calls: ProviderTransferRequest[] = [];
  private readonly statuses = new Map<string, ProviderStatusResult["status"]>();

  async send(request: ProviderTransferRequest): Promise<ProviderTransferResult> {
    this.calls.push(request);
    const providerReference = `provider-${request.clientReference}`;
    this.statuses.set(providerReference, "succeeded");
    this.statuses.set(request.clientReference, "succeeded");

    // Deterministic local failure modes make the exercise runnable without a real provider.
    if (request.destinationAccount.endsWith("99")) {
      return { providerReference, status: "rejected" };
    }
    if (request.destinationAccount.endsWith("88")) {
      // The provider accepted the instruction, but the caller never received the response.
      throw new Error("provider timeout after acceptance");
    }
    return { providerReference, status: "accepted" };
  }

  async getStatus(providerReference: string): Promise<ProviderStatusResult> {
    return { status: this.statuses.get(providerReference) ?? "pending" };
  }

  setStatus(providerReference: string, status: ProviderStatusResult["status"]): void {
    this.statuses.set(providerReference, status);
  }
}
