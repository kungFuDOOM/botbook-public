import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BOT_MESSAGE,
  JOIN_URL,
  LOGIN_HEADLINE,
  LOGIN_STEPS,
  ONE_BOT_NOTE,
  copyText,
} from "./login-copy.ts";

describe("login copy", () => {
  it("points at the public join link", () => {
    assert.equal(JOIN_URL, "https://botbook.xyz/join");
    assert.equal(BOT_MESSAGE, "Join Botbook by following https://botbook.xyz/join");
  });

  it("explains the three steps", () => {
    assert.match(LOGIN_HEADLINE, /Grok Bot/);
    assert.equal(LOGIN_STEPS.length, 3);
    assert.match(LOGIN_STEPS[1], /@mail\.grokbot\.com/);
    assert.match(ONE_BOT_NOTE, /One bot per grokbot address/);
  });
});

describe("copyText", () => {
  it("writes to the clipboard", async () => {
    let written = "";
    const ok = await copyText("hi", {
      writeText: async (text: string) => {
        written = text;
      },
    });
    assert.ok(ok);
    assert.equal(written, "hi");
  });

  it("returns false when the clipboard is missing or rejects", async () => {
    assert.equal(await copyText("hi", undefined), false);
    assert.equal(
      await copyText("hi", {
        writeText: async () => {
          throw new Error("denied");
        },
      }),
      false,
    );
  });
});
