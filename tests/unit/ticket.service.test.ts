import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Mock db
const mockTransaction = vi.fn();
const mockTicketFindFirst = vi.fn();
const mockTicketFindUnique = vi.fn();
const mockTicketCreate = vi.fn();
const mockTicketUpdate = vi.fn();
const mockTicketDelete = vi.fn();
const mockTicketFindMany = vi.fn();
const mockTicketCount = vi.fn();
const mockTicketGroupBy = vi.fn();
const mockMessageCreate = vi.fn();
const mockCustomerFindUnique = vi.fn();
const mockCustomerCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") {
        return fn({
          ticket: {
            findFirst: mockTicketFindFirst,
            create: mockTicketCreate,
            update: mockTicketUpdate,
          },
          ticketMessage: { create: mockMessageCreate },
        });
      }
      return mockTransaction(...args);
    },
    ticket: {
      findFirst: mockTicketFindFirst,
      findUnique: mockTicketFindUnique,
      create: mockTicketCreate,
      update: mockTicketUpdate,
      delete: mockTicketDelete,
      findMany: mockTicketFindMany,
      count: mockTicketCount,
      groupBy: mockTicketGroupBy,
    },
    ticketMessage: { create: mockMessageCreate },
    customer: {
      findUnique: mockCustomerFindUnique,
      create: mockCustomerCreate,
    },
  },
}));

vi.mock("@/lib/api-error", () => ({
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(message: string, code: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

vi.mock("@/lib/services/workspace.service", () => ({
  checkMembership: vi.fn().mockResolvedValue("MEMBER"),
}));

vi.mock("@/lib/services/logger.service", () => ({
  logActivity: vi.fn(),
  generateSummary: vi.fn().mockReturnValue("summary"),
}));

vi.mock("@/lib/services/tickets/customer.service", () => ({
  findOrCreateCustomer: vi.fn().mockResolvedValue({
    id: "cust-1",
    email: "test@example.com",
    name: "Test",
  }),
}));

const baseTicket = {
  id: "t-1",
  number: 1,
  workspaceId: "ws-1",
  title: "Test ticket",
  description: "Test desc",
  source: "INTERNAL" as const,
  category: "GENERAL" as const,
  status: "OPEN" as const,
  priority: "MEDIUM" as const,
  slaDeadline: new Date(Date.now() + 24 * 3600000),
  slaBreached: false,
  needsHumanHelp: false,
  internalCreatorId: "user-1",
  customerId: null,
  assigneeId: null,
  assignedAt: null,
  resolvedAt: null,
  resolvedById: null,
  closedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  internalCreator: { id: "user-1", login: "admin" },
  customer: null,
  assignee: null,
  resolvedBy: null,
  messages: [],
  _count: { messages: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTicketFindFirst.mockResolvedValue(null);
  mockTicketCreate.mockResolvedValue({
    ...baseTicket,
    messages: [
      {
        id: "msg-1",
        authorType: "MANAGER",
        content: "Test desc",
        systemAction: null,
        createdAt: new Date(),
        managerAuthor: { id: "user-1", login: "admin" },
        customerAuthor: null,
      },
    ],
  });
  mockTicketFindUnique.mockResolvedValue(baseTicket);
  mockTicketUpdate.mockResolvedValue(baseTicket);
  mockTicketFindMany.mockResolvedValue([baseTicket]);
  mockTicketCount.mockResolvedValue(1);
  mockTicketGroupBy.mockResolvedValue([{ status: "OPEN", _count: 1 }]);
  mockMessageCreate.mockResolvedValue({
    id: "msg-1",
    authorType: "SYSTEM",
    content: "test",
    systemAction: null,
    createdAt: new Date(),
  });
});

describe("createTicket", () => {
  it("creates INTERNAL ticket with number 1", async () => {
    const { createTicket } =
      await import("@/lib/services/tickets/ticket.service");
    const result = await createTicket(
      {
        workspaceId: "ws-1",
        title: "Test",
        description: "Desc",
        source: "INTERNAL",
      },
      "user-1",
      "ADMIN",
    );
    expect(result.number).toBe(1);
    expect(result.source).toBe("INTERNAL");
    expect(mockTicketCreate).toHaveBeenCalled();
  });

  it("creates EXTERNAL ticket with customer", async () => {
    mockTicketCreate.mockResolvedValue({
      ...baseTicket,
      source: "EXTERNAL",
      customerId: "cust-1",
      customer: { id: "cust-1", email: "test@example.com", name: "Test" },
      internalCreator: null,
      messages: [
        {
          id: "msg-1",
          authorType: "CUSTOMER",
          content: "Help",
          systemAction: null,
          createdAt: new Date(),
          managerAuthor: null,
          customerAuthor: {
            id: "cust-1",
            email: "test@example.com",
            name: "Test",
          },
        },
      ],
    });

    const { createTicket } =
      await import("@/lib/services/tickets/ticket.service");
    const result = await createTicket(
      {
        workspaceId: "ws-1",
        title: "Help",
        description: "Help",
        source: "EXTERNAL",
        customerEmail: "test@example.com",
      },
      "user-1",
      "ADMIN",
    );
    expect(result.source).toBe("EXTERNAL");
  });

  it("calculates correct SLA deadline for URGENT", async () => {
    const { createTicket } =
      await import("@/lib/services/tickets/ticket.service");
    await createTicket(
      {
        workspaceId: "ws-1",
        title: "Urgent",
        description: "Urgent",
        source: "INTERNAL",
        priority: "URGENT",
      },
      "user-1",
      "ADMIN",
    );
    const createCall = mockTicketCreate.mock.calls[0]![0] as {
      data: { slaDeadline: Date };
    };
    const deadline = createCall.data.slaDeadline;
    // Should be ~1 hour from now
    const diffMs = deadline.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(3500000); // >58 min
    expect(diffMs).toBeLessThan(3700000); // <61 min
  });

  it("increments number from last ticket", async () => {
    mockTicketFindFirst.mockResolvedValue({ number: 5 });
    const { createTicket } =
      await import("@/lib/services/tickets/ticket.service");
    await createTicket(
      { workspaceId: "ws-1", title: "T", description: "D", source: "INTERNAL" },
      "user-1",
      "ADMIN",
    );
    const createCall = mockTicketCreate.mock.calls[0]![0] as {
      data: { number: number };
    };
    expect(createCall.data.number).toBe(6);
  });

  it("creates first message with description", async () => {
    const { createTicket } =
      await import("@/lib/services/tickets/ticket.service");
    const result = await createTicket(
      {
        workspaceId: "ws-1",
        title: "T",
        description: "My desc",
        source: "INTERNAL",
      },
      "user-1",
      "ADMIN",
    );
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("changeTicketStatus", () => {
  it("allows reopening CLOSED → OPEN", async () => {
    mockTicketFindUnique
      .mockResolvedValueOnce({ ...baseTicket, status: "CLOSED" })
      .mockResolvedValueOnce({
        ...baseTicket,
        status: "OPEN",
        closedAt: null,
        resolvedAt: null,
        resolvedById: null,
        messages: [
          {
            id: "msg-s",
            authorType: "SYSTEM",
            content: "Статус изменён: CLOSED → OPEN",
            systemAction: "STATUS_CHANGED",
            createdAt: new Date(),
            managerAuthor: null,
            customerAuthor: null,
          },
        ],
        collaborators: [],
      });

    const { changeTicketStatus } =
      await import("@/lib/services/tickets/ticket.service");
    const result = await changeTicketStatus("t-1", "OPEN", "user-1", "ADMIN");
    expect(result.status).toBe("OPEN");
    expect(mockTicketUpdate).toHaveBeenCalled();
  });

  it("rejects invalid transition CLOSED → IN_PROGRESS", async () => {
    mockTicketFindUnique.mockResolvedValue({ ...baseTicket, status: "CLOSED" });
    const { changeTicketStatus } =
      await import("@/lib/services/tickets/ticket.service");
    await expect(
      changeTicketStatus("t-1", "IN_PROGRESS", "user-1", "ADMIN"),
    ).rejects.toThrow();
  });

  it("adds SYSTEM message on status change", async () => {
    mockTicketFindUnique
      .mockResolvedValueOnce({ ...baseTicket, status: "OPEN" })
      .mockResolvedValueOnce({
        ...baseTicket,
        status: "IN_PROGRESS",
        messages: [
          {
            id: "msg-s",
            authorType: "SYSTEM",
            content: "Статус изменён: OPEN → IN_PROGRESS",
            systemAction: "STATUS_CHANGED",
            createdAt: new Date(),
            managerAuthor: null,
            customerAuthor: null,
          },
        ],
      });

    const { changeTicketStatus } =
      await import("@/lib/services/tickets/ticket.service");
    const result = await changeTicketStatus(
      "t-1",
      "IN_PROGRESS",
      "user-1",
      "ADMIN",
    );
    expect(mockMessageCreate).toHaveBeenCalled();
    expect(result.messages.some((m) => m.authorType === "SYSTEM")).toBe(true);
  });

  it("sets resolvedAt when status becomes RESOLVED", async () => {
    mockTicketFindUnique
      .mockResolvedValueOnce({ ...baseTicket, status: "IN_PROGRESS" })
      .mockResolvedValueOnce({
        ...baseTicket,
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolvedById: "user-1",
        messages: [],
      });

    const { changeTicketStatus } =
      await import("@/lib/services/tickets/ticket.service");
    await changeTicketStatus("t-1", "RESOLVED", "user-1", "ADMIN");
    const updateCall = mockTicketUpdate.mock.calls[0]![0] as {
      data: { resolvedAt: Date; resolvedById: string };
    };
    expect(updateCall.data.resolvedAt).toBeInstanceOf(Date);
    expect(updateCall.data.resolvedById).toBe("user-1");
  });
});

describe("listTickets", () => {
  it("returns tickets with counters", async () => {
    mockTransaction.mockResolvedValue([[baseTicket], 1]);
    mockTicketFindMany.mockResolvedValue([baseTicket]);
    mockTicketCount.mockResolvedValue(1);

    const { listTickets } =
      await import("@/lib/services/tickets/ticket.service");
    const result = await listTickets("ws-1", "user-1", "ADMIN");
    expect(result.data).toHaveLength(1);
    expect(result.counters).toHaveProperty("OPEN");
  });

  it("filters by status", async () => {
    mockTicketFindMany.mockResolvedValue([]);
    mockTicketCount.mockResolvedValue(0);

    const { listTickets } =
      await import("@/lib/services/tickets/ticket.service");
    await listTickets("ws-1", "user-1", "ADMIN", { status: ["CLOSED"] });
    // Verify the where clause was passed
    expect(mockTicketFindMany).toHaveBeenCalled();
  });

  it("filters by search", async () => {
    mockTicketFindMany.mockResolvedValue([]);
    mockTicketCount.mockResolvedValue(0);

    const { listTickets } =
      await import("@/lib/services/tickets/ticket.service");
    await listTickets("ws-1", "user-1", "ADMIN", { search: "payment" });
    expect(mockTicketFindMany).toHaveBeenCalled();
  });

  it("filters by slaBreached", async () => {
    mockTicketFindMany.mockResolvedValue([]);
    mockTicketCount.mockResolvedValue(0);

    const { listTickets } =
      await import("@/lib/services/tickets/ticket.service");
    await listTickets("ws-1", "user-1", "ADMIN", { slaBreached: true });
    expect(mockTicketFindMany).toHaveBeenCalled();
  });
});

describe("addMessage", () => {
  it("creates MANAGER message", async () => {
    mockMessageCreate.mockResolvedValue({
      id: "msg-2",
      authorType: "MANAGER",
      content: "Reply",
      systemAction: null,
      createdAt: new Date(),
      managerAuthor: { id: "user-1", login: "admin" },
    });

    const { addMessage } =
      await import("@/lib/services/tickets/ticket.service");
    const msg = await addMessage("t-1", "Reply", "user-1", "ADMIN");
    expect(msg.authorType).toBe("MANAGER");
    expect(msg.content).toBe("Reply");
  });
});

describe("deleteTicket", () => {
  it("only ADMIN can delete", async () => {
    const { deleteTicket } =
      await import("@/lib/services/tickets/ticket.service");
    await expect(deleteTicket("t-1", "user-1", "USER")).rejects.toThrow();
  });
});
