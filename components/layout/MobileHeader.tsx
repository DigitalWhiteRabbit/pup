"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const ThemeToggle = dynamic(
  () => import("./ThemeToggle").then((m) => m.ThemeToggle),
  { ssr: false, loading: () => <span className="w-7 h-7" /> },
);
const NotificationBell = dynamic(
  () =>
    import("@/components/notifications/NotificationBell").then(
      (m) => m.NotificationBell,
    ),
  { ssr: false, loading: () => <span className="w-7 h-7" /> },
);

// Lazy-load the full sidebar content for the mobile drawer
const Sidebar = dynamic(() => import("./Sidebar").then((m) => m.Sidebar), {
  ssr: false,
});

type Props = {
  userLogin: string;
  userRole: "ADMIN" | "USER";
};

export function MobileHeader({ userLogin, userRole }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex md:hidden items-center h-12 px-3 border-b bg-background shrink-0">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Menu className="h-5 w-5" />
            <span className="sr-only">Открыть меню</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <Sidebar
            userLogin={userLogin}
            userRole={userRole}
            onNavigate={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
      <div className="flex-1" />
      <ThemeToggle />
      <NotificationBell />
    </div>
  );
}
