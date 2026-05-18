// Контракт от модуля "Пользователи" (коллега 1).

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

export interface UsersSnapshot {
  total: number;
  activeWithDeposit: number; // юзеры с хотя бы 1 активным депозитом
  newToday: number;
  newWeek: number;
  online: number; // онлайн прямо сейчас
}

export interface SignupPoint {
  date: string; // YYYY-MM-DD
  signups: number;
}

export interface TopReferrer {
  userId: string;
  username: string;
  invitedCount: number;
  activeDescendants: number;
}

export type UserRow = {
  id: number;
  name: string;
  initials: string;
  telegram: string;
  email: string;
  registeredAt: string;
  geo: string;
  wallet: string;
  walletShort: string;
  careerStatus: string;
  statusTone: Tone;
  treeCount: string;
  activeTreeCount: string;
  treeVolume: string;
  personalVolume: string;
  account: "active" | "review" | "blocked";
  referrer: string;
  lastLogin: string;
};

export type ReferralNode = {
  id: string;
  name: string;
  careerStatus: string;
  lineLabel: string;
  treeVolume: string;
  treeCount: string;
  activeTreeCount?: string;
  children: ReferralNode[];
};

export type CareerStatus = {
  id: string;
  name: string;
  order: number;
  tone: Tone;
  description: string;
  conditions: {
    personalVolume: string;
    firstLineVolume: string;
    structureVolume: string;
    activeDirectUsers: string;
    activeDepositRequired: boolean;
  };
};

export type WalletRow = {
  user: string;
  wallet: string;
  network: string;
  txCount: number;
  volume: string;
  lastOperation: string;
  status: string;
  tone: Tone;
};

export type OperationRow = {
  id: string;
  time: string;
  user: string;
  type: string;
  amount: string;
  network: string;
  wallet: string;
  tx: string;
  status: string;
  tone: Tone;
};

export type RiskSignal = {
  type: string;
  signal: string;
  users: number;
  priority: string;
  tone: Tone;
};

export type EventRow = {
  time: string;
  label: string;
  type: string;
  tone: Tone;
};

export type ActivityFunnelRow = [string, string, string];

export interface UsersApi {
  getSnapshot(): Promise<UsersSnapshot>;
  getSignups30d(): Promise<SignupPoint[]>;
  getTopReferrers(limit?: number): Promise<TopReferrer[]>;
}
