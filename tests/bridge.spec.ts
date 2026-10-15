import { expect, test } from "@playwright/test";

const token = "ab".repeat(32);
const baseUrl = "http://127.0.0.1:45678";

test("development bootstrap authenticates without retaining credentials for a later page", async ({ page }) => {
  await page.route(url => url.pathname === "/", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Bridge test</title>" }));
  let requests = 0;
  await page.route(`${baseUrl}/api/snapshot`, route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    requests += 1;
    return route.fulfill({ json: { serverBaseUrl: baseUrl } });
  });
  await page.goto(`/#omniToken=${token}&omniServer=${encodeURIComponent(baseUrl)}`);
  const connect = () => page.evaluate(async () => {
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
    const path = "/src/lib/omni-bridge.ts";
    const bridge = await import(path) as typeof import("../src/lib/omni-bridge");
    return (await bridge.getOmniSnapshot()).serverBaseUrl;
  });
  expect(await connect()).toBe(baseUrl);
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.evaluate(() => sessionStorage.getItem("omni-dev-connection"))).toBeNull();
  await page.route(/http:\/\/127\.0\.0\.1:43\d\d\/api\/snapshot/, route => route.fulfill({ status: 401, body: "Unauthorized" }));
  await page.reload();
  await expect(connect()).rejects.toThrow("pnpm dev:connect");
  expect(requests).toBe(1);
});

test("development bootstrap refuses non-loopback credential destinations", async ({ page }) => {
  await page.route(url => url.pathname === "/", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto(`/#omniToken=${token}&omniServer=${encodeURIComponent("https://attacker.example")}`);
  const message = await page.evaluate(async () => {
    const path = "/src/lib/omni-bridge.ts";
    const bridge = await import(path) as typeof import("../src/lib/omni-bridge");
    try { await bridge.getOmniSnapshot(); } catch (error) { return (error as Error).message; }
    return "unexpected success";
  });
  expect(message).toContain("Invalid development connection");
});
