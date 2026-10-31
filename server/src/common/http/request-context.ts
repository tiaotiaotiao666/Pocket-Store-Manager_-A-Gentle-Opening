import type { Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { resolveRequestId } from '../request-id';

export interface AuthenticatedUser {
  id: string;
  displayName: string;
}

export interface StoreMembershipContext {
  storeId: string;
  role: Role;
}

export type AppRequest = Request & {
  requestId?: string;
  sessionId?: string;
  user?: AuthenticatedUser;
  storeMembership?: StoreMembershipContext;
};

export function applyRequestId(request: AppRequest, response?: Response): string {
  const requestId = resolveRequestId(
    request.headers as unknown as Record<string, unknown>,
    request.requestId,
  );
  request.requestId = requestId;
  if (response && typeof response.setHeader === 'function') {
    response.setHeader('X-Request-Id', requestId);
  }
  return requestId;
}

export function readStringParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === 'string');
    return first;
  }
  return undefined;
}