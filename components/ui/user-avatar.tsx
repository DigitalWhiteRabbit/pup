"use client";

import { useState } from "react";
import Image from "next/image";

const AVATAR_COLORS = [
  "#10b981",
  "#6366f1",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#06b6d4",
  "#84cc16",
  "#e11d48",
  "#7c3aed",
];

/** Stable color based on string hash */
function colorForLogin(login: string): string {
  let hash = 0;
  for (let i = 0; i < login.length; i++) {
    hash = login.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export function UserAvatar({
  userId,
  login,
  size = 32,
  className = "",
}: {
  userId?: string;
  login: string;
  size?: number;
  className?: string;
}) {
  const [imgError, setImgError] = useState(false);

  const showImg = userId && !imgError;

  return (
    <div
      className={`rounded-full flex items-center justify-center font-bold text-white shrink-0 overflow-hidden ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.35,
        background: showImg ? "transparent" : colorForLogin(login),
      }}
    >
      {showImg ? (
        <Image
          src={`/api/users/${userId}/avatar`}
          alt={login}
          width={size}
          height={size}
          className="w-full h-full object-cover"
          unoptimized
          onError={() => setImgError(true)}
        />
      ) : (
        (login[0]?.toUpperCase() ?? "?")
      )}
    </div>
  );
}
