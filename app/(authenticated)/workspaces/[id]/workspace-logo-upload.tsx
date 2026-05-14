"use client";

import { useState, useRef } from "react";
import { Camera, Trash2 } from "lucide-react";
import { WorkspaceLogo } from "@/components/ui/workspace-logo";
import { toastSuccess } from "@/lib/toast";

export function WorkspaceLogoUpload({
  workspaceId,
  name,
  hasLogo,
  isOwner,
}: {
  workspaceId: string;
  name: string;
  hasLogo: boolean;
  isOwner: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [version, setVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/workspaces/${workspaceId}/logo`, {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert(data.error ?? "Ошибка загрузки");
        return;
      }
      toastSuccess("Логотип обновлён");
      setVersion((v) => v + 1);
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    const r = await fetch(`/api/workspaces/${workspaceId}/logo`, {
      method: "DELETE",
    });
    if (r.ok) {
      toastSuccess("Логотип удалён");
      setVersion((v) => v + 1);
    }
  }

  return (
    <div className="relative group">
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      <div className="relative">
        <WorkspaceLogo
          key={version}
          workspaceId={workspaceId}
          name={name}
          hasLogo={hasLogo || version > 0}
          size={64}
          className="rounded-xl"
        />
        {uploading && (
          <div className="absolute inset-0 bg-black/50 rounded-xl flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
      {isOwner && (
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => fileRef.current?.click()}
            className="w-7 h-7 rounded-full bg-card border shadow-sm flex items-center justify-center hover:bg-muted"
            title="Загрузить логотип"
          >
            <Camera className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {(hasLogo || version > 0) && (
            <button
              onClick={() => void remove()}
              className="w-7 h-7 rounded-full bg-card border shadow-sm flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/20"
              title="Удалить логотип"
            >
              <Trash2 className="h-3.5 w-3.5 text-red-400" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
