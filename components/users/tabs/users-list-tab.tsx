import { useMemo, useState } from "react";
import { ArrowLeft, Download, Save, SlidersHorizontal } from "lucide-react";
import { careerStatuses, users } from "@/components/users/users-section-data";
import type { UserRow } from "@/components/users/users-section-data";
import { cn } from "@/lib/utils";
import {
  EmptyRow,
  FilterInput,
  FilterSelect,
  GhostButton,
  Info,
  Panel,
  StatusPill,
} from "../users-ui";
import { includesText, matchesDate, matchesSelect } from "../users-utils";

const accountLabels = {
  active: "Активен",
  review: "Проверка",
  blocked: "Заблокирован",
};

export function UsersListTab({
  selectedUserId,
  onSelectUser,
}: {
  selectedUserId: number;
  onSelectUser: (id: number) => void;
}) {
  const emptyFilters = {
    query: "",
    telegram: "",
    email: "",
    wallet: "",
    registeredAt: "",
    status: "all",
    referrer: "",
    geo: "",
    account: "all",
    walletState: "all",
  };
  const [draftFilters, setDraftFilters] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);

  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      const walletState = user.wallet ? "connected" : "missing";
      return (
        includesText(`${user.id} ${user.name}`, filters.query) &&
        includesText(user.telegram, filters.telegram) &&
        includesText(user.email, filters.email) &&
        includesText(`${user.wallet} ${user.walletShort}`, filters.wallet) &&
        matchesDate(user.registeredAt, filters.registeredAt) &&
        matchesSelect(user.careerStatus.toLowerCase(), filters.status) &&
        includesText(user.referrer, filters.referrer) &&
        includesText(user.geo, filters.geo) &&
        matchesSelect(user.account, filters.account) &&
        matchesSelect(walletState, filters.walletState)
      );
    });
  }, [filters]);

  const profileUser = users.find((user) => user.id === profileUserId);

  if (profileUser) {
    return (
      <UserProfile user={profileUser} onBack={() => setProfileUserId(null)} />
    );
  }

  function updateDraftFilter(key: keyof typeof emptyFilters, value: string) {
    setDraftFilters((current) => ({ ...current, [key]: value }));
  }

  function openProfile(id: number) {
    onSelectUser(id);
    setProfileUserId(id);
  }

  return (
    <>
      <Panel title="Фильтры" meta={`Найдено: ${filteredUsers.length}`}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <FilterInput
            label="ID / имя"
            placeholder="10492 / Иван"
            value={draftFilters.query}
            onChange={(value) => updateDraftFilter("query", value)}
          />
          <FilterInput
            label="Telegram"
            placeholder="@username"
            value={draftFilters.telegram}
            onChange={(value) => updateDraftFilter("telegram", value)}
          />
          <FilterInput
            label="Email"
            placeholder="mail@domain.com"
            value={draftFilters.email}
            onChange={(value) => updateDraftFilter("email", value)}
          />
          <FilterInput
            label="Кошелек"
            placeholder="0x..."
            value={draftFilters.wallet}
            onChange={(value) => updateDraftFilter("wallet", value)}
          />
          <FilterInput
            label="Регистрация"
            type="date"
            value={draftFilters.registeredAt}
            onChange={(value) => updateDraftFilter("registeredAt", value)}
          />
          <FilterSelect
            label="Карьерный статус"
            value={draftFilters.status}
            onChange={(value) => updateDraftFilter("status", value)}
            options={[
              { value: "all", label: "all" },
              ...careerStatuses.map((status) => ({
                value: status.name.toLowerCase(),
                label: status.name,
              })),
            ]}
          />
          <FilterInput
            label="Пригласитель"
            placeholder="ID / username"
            value={draftFilters.referrer}
            onChange={(value) => updateDraftFilter("referrer", value)}
          />
          <FilterInput
            label="Гео"
            placeholder="Страна / город"
            value={draftFilters.geo}
            onChange={(value) => updateDraftFilter("geo", value)}
          />
          <FilterSelect
            label="Аккаунт"
            value={draftFilters.account}
            onChange={(value) => updateDraftFilter("account", value)}
            options={["all", "active", "review", "blocked"]}
          />
          <FilterSelect
            label="Кошелек"
            value={draftFilters.walletState}
            onChange={(value) => updateDraftFilter("walletState", value)}
            options={["all", "connected", "missing", "duplicate"]}
          />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="inline-flex h-10 items-center gap-2 rounded-md bg-foreground px-4 text-sm font-medium text-background"
            type="button"
            onClick={() => setFilters(draftFilters)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Применить фильтр
          </button>
          <button
            className="h-10 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
            type="button"
            onClick={() => {
              setDraftFilters(emptyFilters);
              setFilters(emptyFilters);
            }}
          >
            Сбросить
          </button>
        </div>
      </Panel>

      <Panel
        title="Список пользователей"
        action={
          <GhostButton
            label="Экспорт"
            icon={<Download className="h-4 w-4" />}
          />
        }
      >
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="bg-muted/60 text-muted-foreground">
              <tr>
                {[
                  "ID",
                  "Пользователь",
                  "TG",
                  "Email",
                  "Регистрация",
                  "Гео",
                  "Кошелек",
                  "Статус",
                  "Дерево",
                  "Объем",
                  "Аккаунт",
                ].map((head) => (
                  <th key={head} className="px-4 py-3 font-medium">
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredUsers.map((user) => (
                <tr
                  key={user.id}
                  className={cn(
                    "transition hover:bg-muted/40",
                    selectedUserId === user.id && "bg-muted/40",
                  )}
                >
                  <td className="px-4 py-4">
                    <button
                      className="font-medium underline-offset-4 hover:underline"
                      type="button"
                      onClick={() => openProfile(user.id)}
                    >
                      {user.id}
                    </button>
                  </td>
                  <td className="px-4 py-4 font-medium">{user.name}</td>
                  <td className="px-4 py-4">{user.telegram}</td>
                  <td className="px-4 py-4">{user.email}</td>
                  <td className="px-4 py-4">{user.registeredAt}</td>
                  <td className="px-4 py-4">{user.geo}</td>
                  <td className="px-4 py-4 font-mono">{user.walletShort}</td>
                  <td className="px-4 py-4">
                    <StatusPill tone={user.statusTone}>
                      {user.careerStatus}
                    </StatusPill>
                  </td>
                  <td className="px-4 py-4">{user.treeCount}</td>
                  <td className="px-4 py-4">{user.treeVolume}</td>
                  <td className="px-4 py-4">
                    <StatusPill
                      tone={user.account === "review" ? "warn" : "good"}
                    >
                      {accountLabels[user.account]}
                    </StatusPill>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && <EmptyRow colSpan={11} />}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function UserProfile({ user, onBack }: { user: UserRow; onBack: () => void }) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [manualStatus, setManualStatus] = useState(
    user.careerStatus.toLowerCase(),
  );
  const [reason, setReason] = useState("");

  return (
    <>
      <Panel
        title={user.name}
        meta={`ID ${user.id} · ${user.telegram}`}
        action={
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent"
          >
            <ArrowLeft className="h-4 w-4" /> К списку
          </button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="grid gap-3 sm:grid-cols-2">
            <Info label="Email" value={user.email} />
            <Info label="Регистрация" value={user.registeredAt} />
            <Info label="Гео" value={user.geo} />
            <Info label="Пригласитель" value={user.referrer} />
            <Info label="Кошелек" value={user.wallet} mono />
            <Info label="Последний вход" value={user.lastLogin} />
          </div>
          <div className="grid gap-3">
            <Info
              label="Текущий статус"
              value={
                <StatusPill tone={user.statusTone}>
                  {user.careerStatus}
                </StatusPill>
              }
            />
            <Info label="Личный объем" value={`${user.personalVolume} USDT`} />
            <Info label="Объем структуры" value={`${user.treeVolume} USDT`} />
            <Info label="Дерево" value={`${user.treeCount} пользователей`} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="h-10 rounded-md bg-foreground px-4 text-sm font-medium text-background"
            type="button"
            onClick={() => setEditorOpen((open) => !open)}
          >
            Изменить статус
          </button>
          <button
            className="h-10 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
            type="button"
          >
            Открыть дерево
          </button>
          <button
            className="h-10 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
            type="button"
          >
            Добавить заметку
          </button>
        </div>
      </Panel>

      {editorOpen && (
        <Panel
          title="Ручная правка карьерного статуса"
          meta="Изменение будет фиксироваться в истории действий администратора"
        >
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,280px)_1fr_auto]">
            <FilterSelect
              label="Новый статус"
              value={manualStatus}
              onChange={setManualStatus}
              options={careerStatuses.map((status) => ({
                value: status.name.toLowerCase(),
                label: status.name,
              }))}
            />
            <FilterInput
              label="Причина изменения"
              placeholder="Например: ручная проверка структуры"
              value={reason}
              onChange={setReason}
            />
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center gap-2 self-end rounded-md bg-foreground px-4 text-sm font-medium text-background"
            >
              <Save className="h-4 w-4" />
              Сохранить
            </button>
          </div>
        </Panel>
      )}
    </>
  );
}
