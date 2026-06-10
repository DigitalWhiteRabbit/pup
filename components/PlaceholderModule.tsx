import Link from "next/link";
import {
  Kanban,
  BookOpen,
  Ticket,
  ScrollText,
  MessageSquare,
  Megaphone,
  CalendarDays,
  BarChart3,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModuleKey } from "@/lib/services/workspace.service";

type ModuleMeta = {
  label: string;
  description: string;
  icon: React.ReactNode;
};

const MODULE_META: Record<ModuleKey, ModuleMeta> = {
  crm: {
    label: "CRM-доска",
    description: "Канбан-доска для управления задачами и проектами",
    icon: <Kanban className="h-16 w-16" />,
  },
  knowledge: {
    label: "База знаний",
    description: "Хранилище документов, статей и справочных материалов",
    icon: <BookOpen className="h-16 w-16" />,
  },
  tickets: {
    label: "Тикеты",
    description: "Система обработки обращений и задач поддержки",
    icon: <Ticket className="h-16 w-16" />,
  },
  logs: {
    label: "Логи",
    description: "Журнал событий и действий в workspace",
    icon: <ScrollText className="h-16 w-16" />,
  },
  chat: {
    label: "Чат",
    description: "Внутренний мессенджер для команды",
    icon: <MessageSquare className="h-16 w-16" />,
  },
  marketing: {
    label: "Маркетинг",
    description: "Инструменты для управления маркетинговыми кампаниями",
    icon: <Megaphone className="h-16 w-16" />,
  },
  content: {
    label: "Контент-план",
    description: "Карточки публикаций, модерация и автопубликация",
    icon: <CalendarDays className="h-16 w-16" />,
  },
  analytics: {
    label: "Аналитика",
    description: "Отчёты и дашборды по работе workspace",
    icon: <BarChart3 className="h-16 w-16" />,
  },
  users: {
    label: "Пользователи проекта",
    description: "Управление участниками и ролями в workspace",
    icon: <Users className="h-16 w-16" />,
  },
};

type Props = {
  moduleKey: ModuleKey;
  workspaceId: string;
};

export function PlaceholderModule({ moduleKey, workspaceId }: Props) {
  const meta = MODULE_META[moduleKey];

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <div className="text-muted-foreground/30 mb-6">{meta.icon}</div>
      <h1 className="text-2xl font-bold mb-2">Модуль «{meta.label}»</h1>
      <p className="text-muted-foreground max-w-md mb-8">
        Этот модуль ещё не реализован. Будет добавлен в следующих фазах
        разработки ПУП.
      </p>
      <Button asChild variant="outline">
        <Link href={`/workspaces/${workspaceId}`}>← Вернуться к workspace</Link>
      </Button>
    </div>
  );
}
