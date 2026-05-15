import { ChartLines, Panel, SimpleRows } from "../users-ui";

export function ActivityTab() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Воронка действий">
        <SimpleRows
          rows={[
            ["Посетили сайт", "7 840", "100%"],
            ["Начали регистрацию", "2 190", "27.9%"],
            ["Создали аккаунт", "1 452", "18.5%"],
            ["Подключили Telegram", "1 201", "15.3%"],
            ["Подключили кошелек", "842", "10.7%"],
            ["Первая транзакция", "418", "5.3%"],
          ]}
        />
      </Panel>
      <Panel title="Динамика входов">
        <ChartLines />
      </Panel>
    </div>
  );
}
