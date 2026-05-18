import { useQuery } from "@tanstack/react-query";
import type {
  UsersSnapshot,
  UserRow,
  ReferralNode,
  CareerStatus,
  WalletRow,
  OperationRow,
  RiskSignal,
  EventRow,
  ActivityFunnelRow,
  SignupPoint,
  TopReferrer,
} from "./users-contract";

function proxyUrl(
  workspaceId: string,
  path: string,
  params?: Record<string, string>,
) {
  const searchParams = new URLSearchParams({ path, ...params });
  return `/api/workspaces/${workspaceId}/external-users/proxy?${searchParams.toString()}`;
}

async function fetchProxy<T>(
  workspaceId: string,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const res = await fetch(proxyUrl(workspaceId, path, params));
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export function useUsersSnapshot(workspaceId: string) {
  return useQuery<UsersSnapshot>({
    queryKey: ["users-proxy", workspaceId, "snapshot"],
    queryFn: () => fetchProxy(workspaceId, "/snapshot"),
  });
}

export function useUsersList(
  workspaceId: string,
  params?: { page?: number; pageSize?: number; search?: string },
) {
  return useQuery<{ users: UserRow[]; total: number }>({
    queryKey: ["users-proxy", workspaceId, "users", params],
    queryFn: () =>
      fetchProxy(workspaceId, "/users", {
        ...(params?.page && { page: String(params.page) }),
        ...(params?.pageSize && { pageSize: String(params.pageSize) }),
        ...(params?.search && { search: params.search }),
      }),
  });
}

export function useReferralTree(
  workspaceId: string,
  userId: number | string | null,
) {
  return useQuery<ReferralNode>({
    queryKey: ["users-proxy", workspaceId, "referrals", userId],
    queryFn: () => fetchProxy(workspaceId, `/referrals/${userId}`),
    enabled: userId != null,
  });
}

export function useWallets(workspaceId: string) {
  return useQuery<WalletRow[]>({
    queryKey: ["users-proxy", workspaceId, "wallets"],
    queryFn: () => fetchProxy(workspaceId, "/wallets"),
  });
}

export function useOperations(workspaceId: string) {
  return useQuery<OperationRow[]>({
    queryKey: ["users-proxy", workspaceId, "operations"],
    queryFn: () => fetchProxy(workspaceId, "/operations"),
  });
}

export function useCareerStatuses(workspaceId: string) {
  return useQuery<CareerStatus[]>({
    queryKey: ["users-proxy", workspaceId, "statuses"],
    queryFn: () => fetchProxy(workspaceId, "/statuses"),
  });
}

export function useRiskSignals(workspaceId: string) {
  return useQuery<RiskSignal[]>({
    queryKey: ["users-proxy", workspaceId, "risks"],
    queryFn: () => fetchProxy(workspaceId, "/risks"),
  });
}

export function useEvents(workspaceId: string) {
  return useQuery<EventRow[]>({
    queryKey: ["users-proxy", workspaceId, "events"],
    queryFn: () => fetchProxy(workspaceId, "/events"),
  });
}

export function useActivity(workspaceId: string) {
  return useQuery<ActivityFunnelRow[]>({
    queryKey: ["users-proxy", workspaceId, "activity"],
    queryFn: () => fetchProxy(workspaceId, "/activity"),
  });
}

export function useSignups30d(workspaceId: string) {
  return useQuery<SignupPoint[]>({
    queryKey: ["users-proxy", workspaceId, "signups"],
    queryFn: () => fetchProxy(workspaceId, "/signups"),
  });
}

export function useTopReferrers(workspaceId: string) {
  return useQuery<TopReferrer[]>({
    queryKey: ["users-proxy", workspaceId, "top-referrers"],
    queryFn: () => fetchProxy(workspaceId, "/top-referrers"),
  });
}
