import type {
  VirtualTargetClaimResponseDto,
  VirtualTargetFailureV1,
  VirtualTargetLaunchObservationV1,
  VirtualTargetProgressObservationBody,
  VirtualTargetRegistrationBody,
} from './overlord-contract.js';
export class OverlordClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 512)}`,
      );
    return (await response.json()) as T;
  }
  register(body: VirtualTargetRegistrationBody): Promise<unknown> {
    return this.request('PUT', '/api/virtual-targets/v1/registration', body);
  }
  claim(
    executionTargetId: string,
    gatewayInstanceId: string,
  ): Promise<VirtualTargetClaimResponseDto | null> {
    return this.request<VirtualTargetClaimResponseDto | null>(
      'POST',
      '/api/virtual-targets/v1/claim',
      { executionTargetId, gatewayInstanceId },
    );
  }
  progress(id: string, body: VirtualTargetProgressObservationBody): Promise<unknown> {
    return this.request(
      'POST',
      `/api/virtual-targets/v1/requests/${encodeURIComponent(id)}/progress`,
      body,
    );
  }
  launched(id: string, body: VirtualTargetLaunchObservationV1): Promise<unknown> {
    return this.request(
      'POST',
      `/api/virtual-targets/v1/requests/${encodeURIComponent(id)}/launched`,
      body,
    );
  }
  failed(id: string, body: VirtualTargetFailureV1): Promise<unknown> {
    return this.request(
      'POST',
      `/api/virtual-targets/v1/requests/${encodeURIComponent(id)}/failed`,
      body,
    );
  }
}
