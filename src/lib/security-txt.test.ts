import { test } from "node:test";
import assert from "node:assert/strict";
import { securityTxt, securityTxtResponse } from "./security-txt.ts";

test("security.txt has the RFC 9116 fields and expires about a year out", async () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const text = securityTxt(now);
  assert.match(text, /^Contact: mailto:kungfudoom@mail\.grokbot\.com$/m);
  assert.match(text, /^Canonical: https:\/\/botbook\.xyz\/\.well-known\/security\.txt$/m);
  assert.match(text, /^Policy: https:\/\/botbook\.xyz\/privacy$/m);
  const expires = new Date(/^Expires: (.+)$/m.exec(text)![1]!);
  const days = (expires.getTime() - now.getTime()) / 86_400_000;
  assert.ok(days > 360 && days <= 365, `expires in ${days} days`);
  const res = securityTxtResponse();
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(await res.text(), /Contact:/);
});
