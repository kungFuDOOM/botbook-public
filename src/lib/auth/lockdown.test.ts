import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  gateIdentityAllowed,
  isProductionRuntime,
  newUserAllowed,
  oauthProvidersAllowed,
} from "./lockdown.ts";

const PROD = { NODE_ENV: "production" };
const DEV = { NODE_ENV: "development" };

describe("isProductionRuntime", () => {
  it("is true for NODE_ENV=production or any Vercel runtime", () => {
    assert.equal(isProductionRuntime(PROD), true);
    assert.equal(isProductionRuntime({ VERCEL: "1" }), true);
    assert.equal(isProductionRuntime(DEV), false);
    assert.equal(isProductionRuntime({}), false);
  });
});

describe("gateIdentityAllowed", () => {
  it("only runs in dev or the sandbox", () => {
    assert.equal(gateIdentityAllowed(DEV), true);
    assert.equal(gateIdentityAllowed({}), true);
  });
  it("never runs in production, on Vercel, or on a published project", () => {
    assert.equal(gateIdentityAllowed(PROD), false);
    assert.equal(gateIdentityAllowed({ VERCEL: "1" }), false);
    assert.equal(gateIdentityAllowed({ GROK_PROJECT_ID: "p" }), false);
  });
});

describe("oauthProvidersAllowed", () => {
  it("is on in dev", () => assert.equal(oauthProvidersAllowed(DEV), true));
  it("is off in production by default", () => {
    assert.equal(oauthProvidersAllowed(PROD), false);
    assert.equal(oauthProvidersAllowed({ VERCEL: "1" }), false);
    assert.equal(oauthProvidersAllowed({ ...PROD, BOTBOOK_ENABLE_OAUTH: "false" }), false);
    assert.equal(oauthProvidersAllowed({ ...PROD, BOTBOOK_ENABLE_OAUTH: "" }), false);
  });
  it("needs the explicit flag in production", () => {
    assert.equal(oauthProvidersAllowed({ ...PROD, BOTBOOK_ENABLE_OAUTH: "true" }), true);
  });
});

describe("newUserAllowed (production)", () => {
  it("accepts a grokbot mailbox via email sign-up", () => {
    assert.equal(newUserAllowed("Bot@mail.grokbot.com", "/sign-up/email", PROD), true);
  });
  it("rejects gate viewers and other domains", () => {
    assert.equal(newUserAllowed("abc@viewer.grok.invalid", "/get-session", PROD), false);
    assert.equal(newUserAllowed("me@gmail.com", "/sign-up/email", PROD), false);
  });
  it("rejects a grokbot email arriving through OAuth or any other path", () => {
    assert.equal(newUserAllowed("bot@mail.grokbot.com", "/callback/:providerId", PROD), false);
    assert.equal(
      newUserAllowed("bot@mail.grokbot.com", "/oauth2/callback/:providerId", PROD),
      false,
    );
    assert.equal(newUserAllowed("bot@mail.grokbot.com", undefined, PROD), false);
  });
  it("rejects malformed grokbot addresses", () => {
    assert.equal(newUserAllowed("a@b@mail.grokbot.com", "/sign-up/email", PROD), false);
    assert.equal(newUserAllowed(undefined, "/sign-up/email", PROD), false);
  });
  it("blocks gate viewers even with the OAuth flag on", () => {
    const env = { ...PROD, BOTBOOK_ENABLE_OAUTH: "true" };
    assert.equal(
      newUserAllowed("abc@viewer.grok.invalid", "/oauth2/callback/:providerId", env),
      false,
    );
  });
});

describe("newUserAllowed (dev/sandbox)", () => {
  it("lets gate viewers be created for local development", () => {
    assert.equal(newUserAllowed("abc@viewer.grok.invalid", "/get-session", DEV), true);
  });
});
