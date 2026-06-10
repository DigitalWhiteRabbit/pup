"use client";

import {
  CHANNEL_LABEL,
  CHANNEL_ORDER,
  FORMAT_LABEL,
  FORMAT_ORDER,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  STATUS_LABEL,
  STATUS_ORDER,
} from "@/lib/content/constants";

export type BoardFilter = {
  search: string;
  channel: string;
  status: string;
  priority: string;
  format: string;
  ready: string;
};

export const EMPTY_FILTER: BoardFilter = {
  search: "",
  channel: "",
  status: "",
  priority: "",
  format: "",
  ready: "",
};

const fieldLabel = "text-[11px] font-medium text-muted-foreground";
const selectCls =
  "w-full cursor-pointer rounded-lg border border-input bg-background px-2.5 py-2 text-[13px] focus:border-ring focus:outline-none";

export function Filters({
  filter,
  setFilter,
  onToggleAll,
  onReset,
}: {
  filter: BoardFilter;
  setFilter: (f: BoardFilter) => void;
  onToggleAll: () => void;
  onReset: () => void;
}) {
  const upd = (patch: Partial<BoardFilter>) =>
    setFilter({ ...filter, ...patch });

  return (
    <div className="mb-5 grid grid-cols-2 gap-3 rounded-xl border bg-card p-4 md:grid-cols-6">
      <div className="col-span-2 flex flex-col gap-1.5 md:col-span-6">
        <label className={fieldLabel}>Поиск</label>
        <input
          value={filter.search}
          onChange={(e) => upd({ search: e.target.value })}
          placeholder="Тема, текст, комментарий…"
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-[13px] focus:border-ring focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel}>Соцсеть</label>
        <select
          className={selectCls}
          value={filter.channel}
          onChange={(e) => upd({ channel: e.target.value })}
        >
          <option value="">Все</option>
          {CHANNEL_ORDER.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel}>Статус</label>
        <select
          className={selectCls}
          value={filter.status}
          onChange={(e) => upd({ status: e.target.value })}
        >
          <option value="">Все</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel}>Приоритет</label>
        <select
          className={selectCls}
          value={filter.priority}
          onChange={(e) => upd({ priority: e.target.value })}
        >
          <option value="">Все</option>
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel}>Формат</label>
        <select
          className={selectCls}
          value={filter.format}
          onChange={(e) => upd({ format: e.target.value })}
        >
          <option value="">Все</option>
          {FORMAT_ORDER.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABEL[f]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className={fieldLabel}>Готовность</label>
        <select
          className={selectCls}
          value={filter.ready}
          onChange={(e) => upd({ ready: e.target.value })}
        >
          <option value="">Все</option>
          <option value="ready">Можно публиковать</option>
          <option value="notready">Не готово</option>
        </select>
      </div>

      <div className="col-span-2 flex items-end justify-end gap-2 md:col-span-6">
        <button
          className="rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent"
          onClick={onToggleAll}
        >
          Развернуть / свернуть всё
        </button>
        <button
          className="rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent"
          onClick={onReset}
        >
          Сбросить
        </button>
      </div>
    </div>
  );
}
