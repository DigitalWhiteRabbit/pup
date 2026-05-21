import type { ReactNode } from "react";

type EmptyStateProps = {
  icon: React.ElementType;
  title: string;
  description: string;
  action?: ReactNode;
};

/**
 * Consistent empty-state placeholder used across all modules.
 *
 * Renders a centered icon, heading, description, and an optional action
 * button (e.g. "Create first ...").
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-sm mb-4">
        {description}
      </p>
      {action}
    </div>
  );
}
