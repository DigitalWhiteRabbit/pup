// Контракт от модуля "Пользователи" (коллега 1).

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

export interface UsersApi {
  getSnapshot(): Promise<UsersSnapshot>;
  getSignups30d(): Promise<SignupPoint[]>;
  getTopReferrers(limit?: number): Promise<TopReferrer[]>;
}
