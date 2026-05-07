import "server-only";
import crypto from "crypto";
import bcrypt from "bcrypt";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";

// Base62 alphabet without ambiguous chars: 0/O/l/1
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PASSWORD_LENGTH = 12;
const BCRYPT_COST = 12;

export function generatePassword(): string {
  const bytes = crypto.randomBytes(PASSWORD_LENGTH);
  const chars: string[] = [];
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    const byte = bytes[i] ?? 0;
    chars.push(ALPHABET[byte % ALPHABET.length] ?? "A");
  }
  return chars.join("");
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export type CreatedUser = {
  id: string;
  login: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
};

export async function createUser(input: {
  login: string;
  email: string;
  role: Role;
}): Promise<{ user: CreatedUser; temporaryPassword: string }> {
  const existingLogin = await db.user.findUnique({
    where: { login: input.login },
  });
  if (existingLogin) {
    throw new ApiError(
      "Пользователь с таким логином уже существует",
      "LOGIN_TAKEN",
      409,
    );
  }

  const existingEmail = await db.user.findUnique({
    where: { email: input.email },
  });
  if (existingEmail) {
    throw new ApiError(
      "Пользователь с таким email уже существует",
      "EMAIL_TAKEN",
      409,
    );
  }

  const temporaryPassword = generatePassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const user = await db.user.create({
    data: {
      login: input.login,
      email: input.email,
      role: input.role,
      password: passwordHash,
    },
    select: {
      id: true,
      login: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  });

  return { user, temporaryPassword };
}

export async function deactivateUser(
  id: string,
): Promise<{ id: string; isActive: boolean }> {
  const user = await db.user.findUnique({ where: { id } });
  if (!user) {
    throw new ApiError("Пользователь не найден", "USER_NOT_FOUND", 404);
  }

  return db.user.update({
    where: { id },
    data: { isActive: false },
    select: { id: true, isActive: true },
  });
}

export async function activateUser(
  id: string,
): Promise<{ id: string; isActive: boolean }> {
  const user = await db.user.findUnique({ where: { id } });
  if (!user) {
    throw new ApiError("Пользователь не найден", "USER_NOT_FOUND", 404);
  }

  return db.user.update({
    where: { id },
    data: { isActive: true },
    select: { id: true, isActive: true },
  });
}

export async function resetPassword(
  id: string,
): Promise<{ temporaryPassword: string }> {
  const user = await db.user.findUnique({ where: { id } });
  if (!user) {
    throw new ApiError("Пользователь не найден", "USER_NOT_FOUND", 404);
  }

  const temporaryPassword = generatePassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await db.user.update({
    where: { id },
    data: { password: passwordHash },
  });

  return { temporaryPassword };
}

export async function changeRole(
  id: string,
  role: Role,
): Promise<{ id: string; role: Role }> {
  const user = await db.user.findUnique({ where: { id } });
  if (!user) {
    throw new ApiError("Пользователь не найден", "USER_NOT_FOUND", 404);
  }

  return db.user.update({
    where: { id },
    data: { role },
    select: { id: true, role: true },
  });
}
