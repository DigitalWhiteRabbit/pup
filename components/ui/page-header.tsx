import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
};

/**
 * Standard page header with title, optional subtitle, and action buttons.
 *
 * Usage:
 *   <PageHeader
 *     title="Tickets"
 *     description="Support requests"
 *     actions={<Button>Create</Button>}
 *   />
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-4 md:mb-6 gap-3 md:gap-4 flex-wrap">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}
