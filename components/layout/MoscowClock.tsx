"use client";

import { useState, useEffect } from "react";

export function MoscowClock() {
  const [time, setTime] = useState("");

  useEffect(() => {
    function update() {
      setTime(
        new Date().toLocaleTimeString("ru-RU", {
          timeZone: "Europe/Moscow",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    }
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  if (!time) return null;

  return (
    <div className="text-center text-xs text-muted-foreground tabular-nums">
      🕐 {time} МСК
    </div>
  );
}
