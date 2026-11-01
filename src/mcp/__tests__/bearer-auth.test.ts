import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bearerAuthorised } from "../bearer-auth.js";

describe("bearerAuthorised", () => {
  const token = "secret-token";

  it("accepts a matching Bearer header", () => {
    assert.equal(bearerAuthorised(`Bearer ${token}`, token), true);
  });

  it("rejects a missing header", () => {
    assert.equal(bearerAuthorised(undefined, token), false);
  });

  it("rejects a wrong token without treating prefix-only matches as valid", () => {
    assert.equal(bearerAuthorised(`Bearer ${token}x`, token), false);
    assert.equal(bearerAuthorised("Bearer wrong", token), false);
    assert.equal(bearerAuthorised(`bearer ${token}`, token), false);
  });
});
