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

/** A host path an admin has granted into one person's fence, bound at the same path. */
export interface Mount {
  path: string;
  mode: "rw" | "ro";
}

export interface Userspace {
  id: string;
  root: string;
  home: string;
  store: string;
  sessions: string;
  /** Sockets a service of this userspace listens on. The door reaches them from the host. */
  run: string;
  /** Host paths bound into the fence besides the userspace. Absent or empty: none. */
  mounts?: Mount[];
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
