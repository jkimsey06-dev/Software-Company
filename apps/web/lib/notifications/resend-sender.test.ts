import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const { createResendSender } = await import("./resend-sender");
const email = { to: "owner@example.com", subject: "S", text: "B", idempotencyKey: "notification:1" };

describe("createResendSender", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("passes the idempotency key and returns the provider id", async () => {
    send.mockResolvedValue({ data: { id: "re_1" }, error: null });
    await expect(createResendSender("key", "Alerts <a@example.com>").send(email)).resolves.toEqual({ id: "re_1" });
    expect(send).toHaveBeenCalledWith(
      { from: "Alerts <a@example.com>", to: email.to, subject: "S", text: "B" },
      { idempotencyKey: "notification:1" },
    );
  });

  it.each([
    [429, "rate_limit_exceeded", true],
    [500, "internal_server_error", true],
    [null, "application_error", true],
    [409, "concurrent_idempotent_requests", true],
    [422, "validation_error", false],
    [403, "invalid_from_address", false],
    [409, "invalid_idempotent_request", false],
  ])("status %s %s -> retryable=%s", async (statusCode, name, retryable) => {
    send.mockResolvedValue({ data: null, error: { statusCode, name, message: "x" } });
    await expect(createResendSender("key", "a@example.com").send(email)).rejects.toMatchObject({
      retryable,
      code: name,
    });
  });

  it("treats a thrown network error as retryable", async () => {
    send.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(createResendSender("key", "a@example.com").send(email)).rejects.toMatchObject({
      retryable: true,
      code: "network",
    });
  });
});
