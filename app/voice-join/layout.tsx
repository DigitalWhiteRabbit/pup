import { QueryProvider } from "@/components/providers/query-provider";

// Guest voice-join lives OUTSIDE the authenticated app, so it doesn't inherit
// the root QueryProvider. GuestJoinClient uses react-query (useQuery/
// useQueryClient) → without a provider it threw "No QueryClient set" and the
// page 500'd on SSR. Wrap the guest subtree here.
export default function VoiceJoinLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <QueryProvider>{children}</QueryProvider>;
}
