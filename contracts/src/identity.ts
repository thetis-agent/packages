// Who: users and their roles, the userspace each one owns, and the sessions inside it.
import type { HarnessState } from "./pipeline.js";
import type { Message } from "./messages.js";

export const SYSTEM_USER = "_system";

export type UserRole = "system" | "admin" | "user";
export type UserStatus = "active" | "suspended";

export interface UserRecord {
  id: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

/** The part of a user record a gateway learns from a login token. */
export interface AuthUser {
  id: string;
  role: UserRole;
}

export interface Userspace {
  id: string;
  root: string;
  home: string;
  store: string;
  sessions: string;
  /** Sockets a service of this userspace listens on. The door reaches them from the host. */
  run: string;
}

export interface SessionInfo {
  id: string;
  user: string;
  parent?: string;
}

export interface SessionRecord {
  id: string;
  user: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  conversation: Message[];
  harness: HarnessState;
}

export interface SessionSummaryRef {
  id: string;
  user: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}
