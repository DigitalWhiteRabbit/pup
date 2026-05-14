"use client";

import { useState } from "react";

const COLORS = [
  "#10b981",
  "#6366f1",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length]!;
}

export function WorkspaceLogo({
  workspaceId,
  name,
  hasLogo,
  size = 40,
  className = "",
}: {
  workspaceId: string;
  name: string;
  hasLogo?: boolean;
  size?: number;
  className?: string;
}) {
  const [imgError, setImgError] = useState(false);
  const showImg = hasLogo && !imgError;

  return (
    <div
      className={`rounded-lg flex items-center justify-center font-bold text-white shrink-0 overflow-hidden ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.32,
        background: showImg ? "transparent" : colorForName(name),
      }}
    >
      {showImg ? (
        <img
          src={`/api/workspaces/${workspaceId}/logo`}
          alt={name}
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        name.slice(0, 2)
      )}
    </div>
  );
}
