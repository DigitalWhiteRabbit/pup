import { Loader2 } from "lucide-react";
import { useUsersSnapshot } from "../use-users-data";
import { ChartLines, Metric, Panel } from "../users-ui";

export function OverviewTab({ workspaceId }: { workspaceId: string }) {
  const snapshot = useUsersSnapshot(workspaceId);

  if (snapshot.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (snapshot.error) {
    return (
      <div className="py-8 text-center text-sm text-destructive">
        Ошибка загрузки данных
      </div>
    );
  }

  const s = snapshot.data;

  return (
    <>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Всего пользователей"
          value={s ? s.total.toLocaleString("ru-RU") : "—"}
          hint={
            s ? `+${s.newWeek.toLocaleString("ru-RU")} за неделю` : undefined
          }
          tone="good"
        />
        <Metric
          label="Активные с депозитом"
          value={s ? s.activeWithDeposit.toLocaleString("ru-RU") : "—"}
          tone="good"
        />
        <Metric
          label="Регистрации сегодня"
          value={s ? s.newToday.toLocaleString("ru-RU") : "—"}
          tone="good"
        />
        <Metric
          label="Онлайн сейчас"
          value={s ? s.online.toLocaleString("ru-RU") : "—"}
          tone="neutral"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Посещения, регистрации и входы" meta="Последние 14 дней">
          <div className="flex h-56 items-end gap-2 overflow-hidden rounded-lg border border-border bg-muted/30 p-4">
            {[42, 51, 47, 58, 66, 61, 74, 69, 82, 78, 89, 86, 94, 91].map(
              (height, index) => (
                <div
                  key={`${height}-${index}`}
                  className="flex flex-1 flex-col items-center justify-end gap-2"
                >
                  <div
                    className="w-full rounded-t-md bg-foreground/80"
                    style={{ height: `${height}%` }}
                  />
                </div>
              ),
            )}
          </div>
        </Panel>

        <Panel title="Рост объема структуры" meta="USDT BEP-20">
          <ChartLines />
        </Panel>
      </div>

      <Panel title="Операционные сигналы">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Metric label="Без кошелька" value="—" />
          <Metric label="Кошелек без транзакций" value="—" />
          <Metric label="На проверке рисков" value="—" tone="warn" />
          <Metric label="Дубли IP" value="—" tone="warn" />
          <Metric label="Ручные правки статуса" value="—" />
          <Metric label="Ошибки контракта" value="—" tone="bad" />
        </div>
      </Panel>
    </>
  );
}
