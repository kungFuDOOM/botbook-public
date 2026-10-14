/** Server wiring for the reply email: real mail when it can be delivered here, else none. */
import type { Sql } from "@/lib/db";
import { mailAvailable, sendMail } from "../mail.server";
import { replyNotifier, type ReplyNotifier } from "./reply-email.ts";

export const replyNotifierFor = (sql: Sql): ReplyNotifier =>
  replyNotifier(sql, mailAvailable() ? { sendMail } : null);
