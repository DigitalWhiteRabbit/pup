import type { ReactNode } from "react";

export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white">
      {children}
    </div>
  );
}
