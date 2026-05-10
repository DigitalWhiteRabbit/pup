import "server-only";
import type { TicketPriority } from "@prisma/client";

/**
 * Автоматическое определение приоритета тикета по тексту обращения.
 * Анализирует ключевые слова и паттерны.
 */

const URGENT_KEYWORDS = [
  "срочно",
  "urgent",
  "критично",
  "critical",
  "не работает ничего",
  "полностью сломан",
  "production down",
  "авария",
  "катастрофа",
  "блокер",
  "blocker",
  "всё упало",
  "все упало",
  "сервис недоступен",
  "деньги пропали",
  "потерял деньги",
  "украли",
  "взлом",
  "hack",
  "безопасность",
  "утечка данных",
  "data breach",
];

const HIGH_KEYWORDS = [
  "не работает",
  "ошибка",
  "error",
  "баг",
  "bug",
  "сломалось",
  "broken",
  "не могу войти",
  "не загружается",
  "потерял доступ",
  "пароль не работает",
  "оплата не прошла",
  "платёж",
  "платеж",
  "возврат денег",
  "refund",
  "не отображается",
  "пропало",
  "важно",
  "important",
  "asap",
  "как можно скорее",
];

const LOW_KEYWORDS = [
  "вопрос",
  "подскажите",
  "хотелось бы",
  "было бы неплохо",
  "предложение",
  "suggestion",
  "feature request",
  "пожелание",
  "когда планируете",
  "есть ли возможность",
  "можно ли",
  "интересует",
  "хочу узнать",
  "любопытно",
];

export function detectPriority(text: string): TicketPriority {
  const lower = text.toLowerCase();

  // Проверяем от самого высокого к низкому
  for (const kw of URGENT_KEYWORDS) {
    if (lower.includes(kw)) return "URGENT";
  }

  for (const kw of HIGH_KEYWORDS) {
    if (lower.includes(kw)) return "HIGH";
  }

  for (const kw of LOW_KEYWORDS) {
    if (lower.includes(kw)) return "LOW";
  }

  // По умолчанию — средний
  return "MEDIUM";
}
