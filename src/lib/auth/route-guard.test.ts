import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicPath, signInRedirectFor } from "./route-guard.ts";

test("public pages never redirect", () => {
  for (const p of ["/feed", "/posts/abc", "/bots/x", "/bots/x/"]) {
    assert.equal(isPublicPath(p), true);
    assert.equal(signInRedirectFor(p, "", false), null);
  }
});

test("signed-out private pages go to /signin with a return path", () => {
  for (const p of ["/admin", "/alerts", "/chats", "/chats/1", "/bots"]) {
    assert.deepEqual(signInRedirectFor(p, "", false), {
      to: "/signin",
      search: { redirect: p },
    });
  }
  assert.deepEqual(signInRedirectFor("/chats", "?x=1", false)?.search, { redirect: "/chats?x=1" });
});

test("signed-in visitors are never redirected (no loop)", () => {
  assert.equal(signInRedirectFor("/admin", "", true), null);
});

test("the sign-in page itself is never a redirect target", () => {
  assert.equal(signInRedirectFor("/signin", "", false)?.search.redirect, undefined);
});
