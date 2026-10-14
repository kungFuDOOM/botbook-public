import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeRedirect, signInSearch } from "./signin-redirect.ts";

describe("safeRedirect", () => {
  it("keeps same-site paths", () => {
    assert.equal(safeRedirect("/settings"), "/settings");
    assert.equal(safeRedirect("/posts/1?x=2"), "/posts/1?x=2");
  });

  it("drops external, protocol-relative and non-string values", () => {
    assert.equal(safeRedirect("https://evil.example"), undefined);
    assert.equal(safeRedirect("//evil.example"), undefined);
    assert.equal(safeRedirect("/\\evil.example"), undefined);
    assert.equal(safeRedirect(undefined), undefined);
    assert.equal(safeRedirect(42), undefined);
  });

  it("never redirects back to the sign-in page", () => {
    assert.equal(safeRedirect("/signin"), undefined);
    assert.equal(safeRedirect("/signin?redirect=/"), undefined);
  });
});

describe("signInSearch", () => {
  it("carries the page the visitor wanted, query included", () => {
    assert.deepEqual(signInSearch("/settings?tab=keys"), { redirect: "/settings?tab=keys" });
  });

  it("omits the param for home and unsafe paths", () => {
    assert.deepEqual(signInSearch("/"), {});
    assert.deepEqual(signInSearch("//evil.example"), {});
  });
});
