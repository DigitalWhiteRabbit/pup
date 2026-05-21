import { z } from "zod";

export const loginSchema = z.object({
  loginOrEmail: z.string().min(1, "Введите логин или email"),
  password: z.string().min(1, "Введите пароль"),
});

export const createUserSchema = z.object({
  login: z
    .string()
    .min(3, "Минимум 3 символа")
    .max(50, "Максимум 50 символов")
    .regex(/^[a-zA-Z0-9_-]+$/, "Только буквы, цифры, _ и -"),
  email: z.string().email("Некорректный email"),
  role: z.enum(["ADMIN", "USER"]).optional().default("USER"),
});

export const updateUserRoleSchema = z.object({
  role: z.enum(["ADMIN", "USER"]),
});

const PASSWORD_ERROR = "Минимум 8 символов, строчная и заглавная буква, цифра";

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, PASSWORD_ERROR)
    .regex(/[a-z]/, PASSWORD_ERROR)
    .regex(/[A-Z]/, PASSWORD_ERROR)
    .regex(/[0-9]/, PASSWORD_ERROR),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
