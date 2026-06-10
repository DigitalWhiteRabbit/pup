import { describe, it, expect } from "vitest";
import {
  gates,
  readyCount,
  isReady,
  isOverdue,
  nextStep,
  charInfo,
  shiftDate,
  fmtShort,
  fmtDate,
} from "@/lib/content/derive";
import type { ContentCardView } from "@/lib/content/types";

function mk(over: Partial<ContentCardView> = {}): ContentCardView {
  return {
    id: "c1",
    workspaceId: "w1",
    author: { id: "u1", login: "smm" },
    assignee: null,
    title: "Тема",
    channel: "TELEGRAM",
    format: "POST",
    priority: "MEDIUM",
    status: "DRAFT",
    visualStatus: "NONE",
    publishDate: "2026-06-10",
    visualBrief: null,
    visualLink: null,
    text: null,
    workComment: null,
    adminComment: null,
    publishedUrl: null,
    publishedExternalId: null,
    autoPublish: false,
    proofChecked: false,
    visualApproved: false,
    media: [],
    history: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("content/derive — gates & readiness", () => {
  it("gates reflect each requirement", () => {
    const c = mk({
      text: "  привет ",
      proofChecked: true,
      visualApproved: false,
      publishDate: "2026-06-10",
    });
    const g = gates(c);
    expect(g.text).toBe(true);
    expect(g.proof).toBe(true);
    expect(g.visual).toBe(false);
    expect(g.date).toBe(true);
  });

  it("empty/whitespace text does not satisfy the text gate", () => {
    expect(gates(mk({ text: "   " })).text).toBe(false);
  });

  it("readyCount counts satisfied gates, isReady at 4/4", () => {
    const partial = mk({ text: "x", publishDate: "2026-06-10" });
    expect(readyCount(partial)).toBe(2);
    expect(isReady(partial)).toBe(false);

    const full = mk({
      text: "x",
      proofChecked: true,
      visualApproved: true,
      publishDate: "2026-06-10",
    });
    expect(readyCount(full)).toBe(4);
    expect(isReady(full)).toBe(true);
  });
});

describe("content/derive — isOverdue", () => {
  it("past date with non-final status is overdue", () => {
    expect(
      isOverdue(
        mk({ publishDate: "2026-06-01", status: "DRAFT" }),
        "2026-06-10",
      ),
    ).toBe(true);
  });
  it("published or paused are never overdue", () => {
    expect(
      isOverdue(
        mk({ publishDate: "2026-06-01", status: "PUBLISHED" }),
        "2026-06-10",
      ),
    ).toBe(false);
    expect(
      isOverdue(
        mk({ publishDate: "2026-06-01", status: "PAUSED" }),
        "2026-06-10",
      ),
    ).toBe(false);
  });
  it("no date is not overdue", () => {
    expect(isOverdue(mk({ publishDate: null }), "2026-06-10")).toBe(false);
  });
});

describe("content/derive — nextStep", () => {
  it("guides through the workflow", () => {
    expect(nextStep(mk({ status: "PUBLISHED" }))).toBe("Опубликовано");
    expect(nextStep(mk({ status: "IDEA" }))).toBe("Дополнить и в черновик");
    expect(nextStep(mk({ status: "DRAFT", text: null }))).toBe(
      "Заполнить текст",
    );
    expect(nextStep(mk({ status: "DRAFT", text: "x" }))).toBe(
      "Отправить на вычитку",
    );
    expect(
      nextStep(mk({ status: "REVIEW", text: "x", proofChecked: false })),
    ).toBe("Ждёт проверки менеджера");
    expect(
      nextStep(
        mk({
          status: "READY",
          text: "x",
          proofChecked: true,
          visualApproved: false,
        }),
      ),
    ).toBe("Согласовать визуал");
    expect(
      nextStep(
        mk({
          status: "READY",
          text: "x",
          proofChecked: true,
          visualApproved: true,
          publishDate: "2026-06-10",
        }),
      ),
    ).toBe("Публиковать");
  });
});

describe("content/derive — formatting & misc", () => {
  it("charInfo counts chars and words", () => {
    expect(charInfo(mk({ text: "раз два три" }))).toBe("11 симв. / 3 слов");
    expect(charInfo(mk({ text: "" }))).toBe("нет текста");
  });
  it("shiftDate moves by N days", () => {
    expect(shiftDate("2026-06-10", 1)).toBe("2026-06-11");
    expect(shiftDate("2026-06-01", -1)).toBe("2026-05-31");
  });
  it("fmtShort / fmtDate render Russian dates", () => {
    expect(fmtShort("2026-05-31")).toBe("31 мая");
    expect(fmtDate("2026-05-31")).toBe("31 мая 2026");
    expect(fmtShort(null)).toBe("—");
  });
});
