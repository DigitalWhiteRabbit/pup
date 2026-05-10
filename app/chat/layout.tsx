import type { ReactNode } from "react";

export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen"
      style={{
        background:
          "linear-gradient(180deg, #fef7ed 0%, #fef3e2 30%, #faf5f0 100%)",
      }}
    >
      {children}
    </div>
  );
}
