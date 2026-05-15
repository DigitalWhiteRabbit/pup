import { ChartLines, Metric, Panel } from "../users-ui";

export function OverviewTab() {
  return (
    <>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Всего пользователей"
          value="11 452"
          hint="+530 за 5 дней"
          tone="good"
        />
        <Metric
          label="Активные за 7 дней"
          value="3 187"
          hint="+14,8%"
          tone="good"
        />
        <Metric
          label="Регистрации сегодня"
          value="236"
          hint="из них 172 по рефералам"
          tone="good"
        />
        <Metric
          label="Объем деревьев"
          value="2.84M USDT"
          hint="BEP-20"
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
          <Metric label="Без кошелька" value="1 904" />
          <Metric label="Кошелек без транзакций" value="842" />
          <Metric label="На проверке рисков" value="37" tone="warn" />
          <Metric label="Дубли IP" value="126" tone="warn" />
          <Metric label="Ручные правки статуса" value="19" />
          <Metric label="Ошибки контракта" value="8" tone="bad" />
        </div>
      </Panel>
    </>
  );
}
