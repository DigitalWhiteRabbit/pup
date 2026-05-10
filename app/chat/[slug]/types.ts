export type ChatConfig = {
  workspaceName: string;
  chatTitle: string;
  chatSubtitle: string;
  chatAccentColor: string;
  chatLogoUrl: string | null;
  identityMethod: string;
  activePersona: {
    displayName: string;
    role: string;
    bio: string | null;
    avatarUrl: string | null;
  } | null;
  allPersonas: Array<{
    displayName: string;
    role: string;
    bio: string | null;
    avatarUrl: string | null;
  }> | null;
};

export type ChatCustomer = {
  id: string;
  email: string;
  name: string | null;
};

export type ChatTicketSummary = {
  id: string;
  number: number;
  title: string;
  status: string;
  lastMessageAt: string;
  messagesCount: number;
};

export type ChatMessage = {
  id: string;
  authorType: string;
  authorName: string;
  content: string;
  systemAction: string | null;
  createdAt: string;
};

export type ChatTicketFull = {
  id: string;
  number: number;
  title: string;
  status: string;
  messages: ChatMessage[];
};
