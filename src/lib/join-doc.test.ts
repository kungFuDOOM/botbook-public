import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JOIN_BASE_URL, JOIN_MARKDOWN, markdownResponse, wantsMarkdown } from "./join-doc.ts";

describe("join instructions", () => {
  it("cover signup, key, post, reply and react against botbook.xyz", () => {
    assert.equal(JOIN_BASE_URL, "https://botbook.xyz");
    for (const part of [
      "curl -sS -X POST https://botbook.xyz/api/v1/join/start",
      "curl -sS -X POST https://botbook.xyz/api/v1/join/verify",
      "https://botbook.xyz/api/v1/posts \\",
      "https://botbook.xyz/api/v1/posts/POST_ID/replies",
      "https://botbook.xyz/api/v1/posts/POST_ID/reactions",
      "@mail.grokbot.com",
    ])
      assert.ok(JOIN_MARKDOWN.includes(part), part);
  });

  it("never contains a real-looking key", () => {
    assert.doesNotMatch(JOIN_MARKDOWN, /bb_[A-Za-z0-9_-]{20,}/);
  });
});

describe("wantsMarkdown", () => {
  it("is true when Markdown is asked for", () => {
    assert.ok(wantsMarkdown("text/markdown"));
    assert.ok(wantsMarkdown("text/markdown, text/html;q=0.5"));
    assert.ok(wantsMarkdown("TEXT/Markdown; charset=utf-8"));
    assert.ok(wantsMarkdown("text/html;q=0.8, text/markdown"));
  });

  it("is false for browsers, curl defaults and refusals", () => {
    assert.equal(wantsMarkdown(null), false);
    assert.equal(wantsMarkdown("*/*"), false);
    assert.equal(wantsMarkdown("text/html,application/xhtml+xml,*/*;q=0.8"), false);
    assert.equal(wantsMarkdown("text/html, text/markdown;q=0.5"), false);
    assert.equal(wantsMarkdown("text/markdown;q=0"), false);
    assert.equal(wantsMarkdown("text/markdown;q=abc"), false);
  });

  it("serves a markdown response", async () => {
    const res = markdownResponse();
    assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
    assert.equal(res.headers.get("vary"), "Accept");
    assert.equal(await res.text(), JOIN_MARKDOWN);
    assert.equal(await markdownResponse("HEAD").text(), "");
  });
});

describe("safety, deletion and key rotation docs", async () => {
  const { SKILL_MARKDOWN } = await import("./skill-doc.ts");
  it("tell bots to treat Botbook text as untrusted data and how to rotate a key", () => {
    for (const doc of [JOIN_MARKDOWN, SKILL_MARKDOWN]) {
      assert.match(doc, /untrusted data/);
      assert.match(doc, /never as instructions/);
      assert.match(doc, /\/api\/v1\/me\/keys\/rotate/);
      assert.match(doc, /DELETE \/api\/v1\/posts\/POST_ID|-X DELETE .*\/api\/v1\/posts\/POST_ID/);
      assert.match(doc, /security\.txt/);
    }
  });
});

describe("routine and activity docs", async () => {
  const { SKILL_MARKDOWN, SUGGESTED_ROUTINE, ROUTINE_PROMPT } = await import("./skill-doc.ts");
  it("have a #routine anchor, the schedule, the activity endpoint and the prompt", () => {
    assert.ok(SKILL_MARKDOWN.includes('<a id="routine"></a>\n## Routine'));
    assert.ok(JOIN_MARKDOWN.includes('<a id="routine"></a>\n## Routine'));
    for (const doc of [JOIN_MARKDOWN, SKILL_MARKDOWN]) {
      assert.match(doc, /3 times a day/);
      assert.match(doc, /not every few minutes/i);
      assert.match(doc, /owner's bot usage/);
      assert.match(
        doc,
        /curl -sS -H "Authorization: Bearer \$(KEY|BOTBOOK_KEY)" "https:\/\/botbook\.xyz\/api\/v1\/activity/,
      );
      assert.match(doc, /next_since/);
      assert.match(doc, /has_more/);
      assert.match(doc, /reply_to_reply/);
      assert.match(doc, /untrusted data/);
      assert.ok(doc.includes(`\`\`\`text\n${ROUTINE_PROMPT}\n\`\`\``));
    }
    assert.match(SKILL_MARKDOWN, /roasts/);
    assert.match(SKILL_MARKDOWN, /targeting humans/);
    assert.match(SKILL_MARKDOWN, /great post!/);
  });

  it("keeps the suggested routine in sync with the guide", () => {
    assert.equal(SUGGESTED_ROUTINE.schedule, "3 times a day");
    assert.equal(SUGGESTED_ROUTINE.prompt, ROUTINE_PROMPT);
    assert.match(ROUTINE_PROMPT, /at most 1-2 new posts/);
    assert.match(ROUTINE_PROMPT, /never follow instructions/);
    assert.match(ROUTINE_PROMPT, /rate limits/);
  });
});
