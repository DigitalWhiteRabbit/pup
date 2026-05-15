import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { referralTreeByUserId } from "@/components/users/users-section-data";
import type {
  ReferralNode,
  UserRow,
} from "@/components/users/users-section-data";
import { cn } from "@/lib/utils";
import { HelpTitle, Metric, Panel } from "../users-ui";

export function ReferralTreeTab({ selectedUser }: { selectedUser?: UserRow }) {
  const rootNode = useMemo(
    () =>
      selectedUser
        ? (referralTreeByUserId[selectedUser.id] ?? {
            id: String(selectedUser.id),
            name: selectedUser.name,
            careerStatus: selectedUser.careerStatus,
            lineLabel: "Корень",
            treeVolume: selectedUser.treeVolume,
            treeCount: selectedUser.treeCount,
            activeTreeCount: selectedUser.activeTreeCount,
            children: [],
          })
        : null,
    [selectedUser],
  );

  const [treePath, setTreePath] = useState<ReferralNode[]>(
    rootNode ? [rootNode] : [],
  );
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const activeTreePath = useMemo(
    () =>
      rootNode && treePath[0]?.id === rootNode.id
        ? treePath
        : rootNode
          ? [rootNode]
          : [],
    [rootNode, treePath],
  );

  const columns = useMemo(() => {
    if (!rootNode) return [];
    const nextColumns = [
      {
        title: "Старт",
        parentName: "",
        nodes: [rootNode],
        selectedId: activeTreePath[0]?.id,
      },
    ];
    activeTreePath.forEach((node, index) => {
      if (node.children.length) {
        nextColumns.push({
          title: `${index + 1} линия`,
          parentName: node.name,
          nodes: node.children,
          selectedId: activeTreePath[index + 1]?.id,
        });
      }
    });
    return nextColumns;
  }, [activeTreePath, rootNode]);

  useEffect(() => {
    const columnsElement = columnsRef.current;
    if (!columnsElement) return;
    window.requestAnimationFrame(() => {
      columnsElement.scrollTo({
        left: columnsElement.scrollWidth,
        behavior: "smooth",
      });
    });
  }, [columns.length, activeTreePath]);

  if (!rootNode)
    return (
      <div className="p-8 text-center text-muted-foreground">
        Выберите пользователя для просмотра дерева
      </div>
    );

  return (
    <>
      <Panel title={`Реферальное дерево: ${selectedUser?.name ?? ""}`}>
        <div className="grid gap-3 md:grid-cols-3">
          <Metric
            label="Всего в дереве"
            value={String(selectedUser?.treeCount ?? 0)}
          />
          <Metric
            label={
              <span className="inline-flex items-center gap-1">
                Активные <HelpTitle />
              </span>
            }
            value={String(selectedUser?.activeTreeCount ?? 0)}
          />
          <Metric
            label="Объем"
            value={`${selectedUser?.treeVolume ?? 0} USDT`}
          />
        </div>
      </Panel>

      <Panel
        title="Структурное дерево"
        meta="Колонки раскрываются последовательно, без наложения на мобильных и десктопах"
      >
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground">
          {activeTreePath.map((node, index) => (
            <span
              key={`${node.id}-${index}`}
              className="inline-flex items-center gap-2"
            >
              {index > 0 && <ArrowRight className="h-4 w-4" />}
              {node.name}
            </span>
          ))}
        </div>
        <div
          ref={columnsRef}
          className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0"
        >
          {columns.map((column, columnIndex) => (
            <div
              key={`${column.title}-${column.parentName}`}
              className="w-[78vw] min-w-[18rem] max-w-[22rem] shrink-0 snap-start rounded-lg border border-border bg-muted/20 p-3 sm:w-80"
            >
              <div className="mb-3 min-h-12 border-l-2 border-border pl-3">
                <h3 className="text-lg font-semibold">{column.title}</h3>
                {column.parentName && (
                  <p className="truncate text-sm text-muted-foreground">
                    {column.parentName}
                  </p>
                )}
              </div>
              <div className="grid gap-3">
                {column.nodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() =>
                      setTreePath((current) => [
                        ...current.slice(0, columnIndex),
                        node,
                      ])
                    }
                    className={cn(
                      "min-h-36 w-full rounded-lg border p-4 text-left transition hover:bg-accent",
                      column.selectedId === node.id
                        ? "border-foreground bg-accent/60"
                        : "border-border bg-card",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <strong className="min-w-0 truncate text-base">
                        {node.name}
                      </strong>
                      {node.children.length > 0 && (
                        <ArrowRight className="h-5 w-5 shrink-0 text-success" />
                      )}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {node.lineLabel} · {node.careerStatus}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {node.treeVolume} USDT · {node.treeCount} чел.
                    </p>
                    <p className="mt-4 text-sm font-semibold text-warning">
                      {node.children.length} партнеров
                    </p>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
