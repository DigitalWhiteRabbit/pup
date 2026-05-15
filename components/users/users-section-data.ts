import type {
  SignupPoint,
  TopReferrer,
  UsersSnapshot,
} from "@/components/users/users-contract";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

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

export const users: UserRow[] = [
  {
    id: 10492,
    name: "Иван Орлов",
    initials: "ИО",
    telegram: "@orlov",
    email: "ivan@mail.com",
    registeredAt: "05.05.2026",
    geo: "RU, Москва",
    wallet: "0x91b4c0e7aB10c9A12f8Ad2",
    walletShort: "0x91b...8Ad2",
    careerStatus: "Leader",
    statusTone: "info",
    treeCount: "348",
    activeTreeCount: "219",
    treeVolume: "184 230",
    personalVolume: "34 200",
    account: "active",
    referrer: "ID 9981 · @mentor",
    lastLogin: "07.05.2026, 12:35",
  },
  {
    id: 10318,
    name: "Anna Lee",
    initials: "AL",
    telegram: "@annalee",
    email: "anna@mail.com",
    registeredAt: "02.05.2026",
    geo: "AE, Dubai",
    wallet: "0xa50241c0f9B88a10C31F0",
    walletShort: "0xa50...31F0",
    careerStatus: "Starter",
    statusTone: "warn",
    treeCount: "41",
    activeTreeCount: "28",
    treeVolume: "18 450",
    personalVolume: "1 900",
    account: "active",
    referrer: "ID 10492 · @orlov",
    lastLogin: "07.05.2026, 09:41",
  },
  {
    id: 10177,
    name: "Сергей Волков",
    initials: "СВ",
    telegram: "@svcrypto",
    email: "sergey@mail.com",
    registeredAt: "27.04.2026",
    geo: "KZ, Алматы",
    wallet: "0xd81117e9b4aC1000Ab44",
    walletShort: "0xd81...Ab44",
    careerStatus: "Director",
    statusTone: "info",
    treeCount: "901",
    activeTreeCount: "588",
    treeVolume: "672 100",
    personalVolume: "128 000",
    account: "review",
    referrer: "ID 9210 · @leadmax",
    lastLogin: "07.05.2026, 11:08",
  },
  {
    id: 10046,
    name: "Мария Нова",
    initials: "МН",
    telegram: "@m_nova",
    email: "maria@mail.com",
    registeredAt: "21.04.2026",
    geo: "TR, Istanbul",
    wallet: "0x77cf1eabc0D9139Ae11",
    walletShort: "0x77c...Ae11",
    careerStatus: "Member",
    statusTone: "neutral",
    treeCount: "12",
    activeTreeCount: "7",
    treeVolume: "2 740",
    personalVolume: "0",
    account: "active",
    referrer: "ID 10492 · @orlov",
    lastLogin: "07.05.2026, 10:40",
  },
];

export const referralTreeByUserId: Record<number, ReferralNode> = {
  10492: {
    id: "10492",
    name: "Иван Орлов",
    careerStatus: "Leader",
    lineLabel: "Корень",
    treeVolume: "184 230",
    treeCount: "348",
    activeTreeCount: "219",
    children: [
      {
        id: "10318",
        name: "Anna Lee",
        careerStatus: "Starter",
        lineLabel: "1 линия",
        treeVolume: "18 450",
        treeCount: "41",
        children: [
          {
            id: "20114",
            name: "Alex Kim",
            careerStatus: "Member",
            lineLabel: "2 линия",
            treeVolume: "4 120",
            treeCount: "8",
            children: [
              {
                id: "30102",
                name: "Nina Park",
                careerStatus: "Member",
                lineLabel: "3 линия",
                treeVolume: "960",
                treeCount: "3",
                children: [
                  {
                    id: "40177",
                    name: "Denis Ford",
                    careerStatus: "Starter",
                    lineLabel: "4 линия",
                    treeVolume: "420",
                    treeCount: "1",
                    children: [],
                  },
                ],
              },
              {
                id: "30108",
                name: "Omar Said",
                careerStatus: "Member",
                lineLabel: "3 линия",
                treeVolume: "330",
                treeCount: "1",
                children: [],
              },
            ],
          },
          {
            id: "20121",
            name: "Ольга Мир",
            careerStatus: "Starter",
            lineLabel: "2 линия",
            treeVolume: "11 800",
            treeCount: "23",
            children: [],
          },
        ],
      },
      {
        id: "10177",
        name: "Сергей Волков",
        careerStatus: "Director",
        lineLabel: "1 линия",
        treeVolume: "672 100",
        treeCount: "901",
        children: [
          {
            id: "20288",
            name: "Aziz Khan",
            careerStatus: "Leader",
            lineLabel: "2 линия",
            treeVolume: "87 300",
            treeCount: "116",
            children: [
              {
                id: "30318",
                name: "Lara Moon",
                careerStatus: "Starter",
                lineLabel: "3 линия",
                treeVolume: "14 100",
                treeCount: "31",
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: "10046",
        name: "Мария Нова",
        careerStatus: "Member",
        lineLabel: "1 линия",
        treeVolume: "2 740",
        treeCount: "12",
        children: [],
      },
    ],
  },
};

export const walletRows = users.map((user, index) => ({
  user: user.name,
  wallet: user.wallet,
  network: "BSC",
  txCount: [18, 3, 91, 0][index],
  volume: [
    `${user.personalVolume} USDT`,
    "1 900 USDT",
    "128 000 USDT",
    "0 USDT",
  ][index],
  lastOperation: ["07.05.2026", "06.05.2026", "07.05.2026", "-"][index],
  status: ["synced", "synced", "review", "noOperations"][index],
  tone: ["good", "good", "warn", "neutral"][index] as Tone,
}));

export const operationRows = [
  {
    id: "op-7801",
    time: "07.05.2026 12:44",
    user: "Иван Орлов",
    type: "deposit",
    amount: "12 000 USDT",
    network: "BEP-20",
    wallet: "0x91b...8Ad2",
    tx: "0x7f1...91da",
    status: "confirmed",
    tone: "good" as Tone,
  },
  {
    id: "op-7798",
    time: "07.05.2026 12:18",
    user: "Anna Lee",
    type: "referralAccrual",
    amount: "420 USDT",
    network: "BEP-20",
    wallet: "0xa50...31F0",
    tx: "0x3aa...e0c4",
    status: "confirmed",
    tone: "good" as Tone,
  },
  {
    id: "op-7794",
    time: "07.05.2026 11:36",
    user: "Сергей Волков",
    type: "statusVolumeSync",
    amount: "18 700 USDT",
    network: "Subgraph",
    wallet: "0xd81...Ab44",
    tx: "sync-4931",
    status: "review",
    tone: "warn" as Tone,
  },
  {
    id: "op-7789",
    time: "07.05.2026 10:52",
    user: "Мария Нова",
    type: "withdrawal",
    amount: "250 USDT",
    network: "BEP-20",
    wallet: "0x77c...Ae11",
    tx: "0x8bc...117a",
    status: "rejected",
    tone: "bad" as Tone,
  },
  {
    id: "op-7784",
    time: "06.05.2026 18:10",
    user: "Иван Орлов",
    type: "treeRecalculation",
    amount: "184 230 USDT",
    network: "Indexer",
    wallet: "0x91b...8Ad2",
    tx: "tree-10492",
    status: "confirmed",
    tone: "info" as Tone,
  },
];

export const careerStatuses: CareerStatus[] = [
  {
    id: "member",
    name: "Member",
    order: 1,
    tone: "neutral",
    description: "Базовый статус участника проекта.",
    conditions: {
      personalVolume: "0",
      firstLineVolume: "0",
      structureVolume: "0",
      activeDirectUsers: "0",
      activeDepositRequired: false,
    },
  },
  {
    id: "starter",
    name: "Starter",
    order: 2,
    tone: "warn",
    description: "Начальный активный партнер с подтвержденным участием.",
    conditions: {
      personalVolume: "10",
      firstLineVolume: "0",
      structureVolume: "0",
      activeDirectUsers: "3",
      activeDepositRequired: true,
    },
  },
  {
    id: "leader",
    name: "Leader",
    order: 3,
    tone: "info",
    description: "Партнер с развитой первой линией и активной структурой.",
    conditions: {
      personalVolume: "1000",
      firstLineVolume: "10000",
      structureVolume: "100000",
      activeDirectUsers: "10",
      activeDepositRequired: true,
    },
  },
  {
    id: "director",
    name: "Director",
    order: 4,
    tone: "good",
    description: "Высокий карьерный статус для устойчивой структуры.",
    conditions: {
      personalVolume: "5000",
      firstLineVolume: "50000",
      structureVolume: "500000",
      activeDirectUsers: "25",
      activeDepositRequired: true,
    },
  },
];

export const riskSignals = [
  {
    type: "Кошелек",
    signal: "Один кошелек найден у нескольких аккаунтов",
    users: 2,
    priority: "Высокий",
    tone: "bad" as Tone,
  },
  {
    type: "IP",
    signal: "Массовая регистрация с одного IP",
    users: 24,
    priority: "Средний",
    tone: "warn" as Tone,
  },
  {
    type: "Статус",
    signal: "Расхождение статуса и объема структуры",
    users: 19,
    priority: "Средний",
    tone: "warn" as Tone,
  },
  {
    type: "Рефералы",
    signal: "Резкий рост одной ветки",
    users: 1,
    priority: "Наблюдать",
    tone: "info" as Tone,
  },
];

export const events = [
  {
    time: "07.05 12:35",
    label: "Иван Орлов подключил кошелек",
    type: "wallet",
    tone: "good" as Tone,
  },
  {
    time: "07.05 12:21",
    label: "admin@core изменил статус Starter -> Leader",
    type: "admin",
    tone: "warn" as Tone,
  },
  {
    time: "07.05 11:54",
    label: "Anna Lee зарегистрировалась по ссылке @orlov",
    type: "referral",
    tone: "info" as Tone,
  },
  {
    time: "07.05 11:18",
    label: "Смарт-контракт вернул ошибку синхронизации",
    type: "contract",
    tone: "bad" as Tone,
  },
  {
    time: "07.05 10:40",
    label: "Мария Нова вошла в систему",
    type: "login",
    tone: "neutral" as Tone,
  },
];

export const usersSnapshot: UsersSnapshot = {
  total: 11_452,
  activeWithDeposit: 3_187,
  newToday: 236,
  newWeek: 1_284,
  online: 530,
};

export const signups30d: SignupPoint[] = makeSignups30d();

export const topReferrers: TopReferrer[] = users.map((user) => ({
  userId: String(user.id),
  username: user.telegram,
  invitedCount: Number(user.treeCount.replace(/\s/g, "")) || 0,
  activeDescendants: Number(user.activeTreeCount.replace(/\s/g, "")) || 0,
}));

function makeSignups30d(): SignupPoint[] {
  const days = 30;
  const today = new Date();

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - 1 - index));

    const seasonal = Math.round(Math.sin(index / 2.4) * 18);
    const weeklySpike = index % 7 === 0 ? 24 : 0;
    const signups = Math.max(
      8,
      42 + seasonal + Math.round(index * 1.1) + weeklySpike,
    );

    return {
      date: date.toISOString().slice(0, 10),
      signups,
    };
  });
}
