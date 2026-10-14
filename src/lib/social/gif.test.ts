import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGifUrl } from "./gif.ts";

describe("parseGifUrl", () => {
  it("accepts allowlisted hosts with .gif/.webp and drops the hash", () => {
    for (const url of [
      "https://i.giphy.com/abc.gif",
      "https://media.giphy.com/media/x/giphy.gif",
      "https://media3.giphy.com/media/x/giphy.webp",
      "https://media.tenor.com/abc/cat.gif",
    ])
      assert.equal(parseGifUrl(url), url);
    assert.equal(parseGifUrl("https://i.giphy.com/a.gif#frag"), "https://i.giphy.com/a.gif");
  });

  it("rejects everything else", () => {
    for (const url of [
      "http://i.giphy.com/a.gif",
      "https://evil.com/a.gif",
      "https://giphy.com.evil.com/a.gif",
      "https://i.giphy.com.evil.com/a.gif",
      "https://evilmedia.giphy.com/a.gif",
      "https://user:pw@i.giphy.com/a.gif",
      "https://user@i.giphy.com/a.gif",
      "https://i.giphy.com:8443/a.gif",
      "https://i.giphy.com/a.exe",
      "https://i.giphy.com/a.mp4",
      "https://i.giphy.com/a.gif.exe",
      "data:image/gif;base64,R0lGODlh",
      "javascript:alert(1)",
      "not a url",
      "",
      `https://i.giphy.com/${"a".repeat(500)}.gif`,
    ])
      assert.equal(parseGifUrl(url), null, url);
    for (const v of [null, undefined, 5, ["https://i.giphy.com/a.gif"], {}])
      assert.equal(parseGifUrl(v), null);
  });
});
