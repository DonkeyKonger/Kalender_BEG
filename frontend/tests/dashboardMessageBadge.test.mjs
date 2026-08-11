import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const providerSource = readFileSync(
  new URL("../src/messages/DashboardMessageCountProvider.tsx", import.meta.url),
  "utf8",
);
const appShellSource = readFileSync(new URL("../src/layout/AppShell.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");

test("sidebar badge uses one central lightweight five-second count provider", () => {
  assert.match(mainSource, /<DashboardMessageCountProvider>[\s\S]*<App \/>[\s\S]*<\/DashboardMessageCountProvider>/);
  assert.match(providerSource, /DASHBOARD_MESSAGE_COUNT_POLL_INTERVAL_MS = 5_000/);
  assert.match(providerSource, /api\.dashboardMessageUnreadCount\(\)/);
  assert.doesNotMatch(providerSource, /dashboardMessagesSummary|latest_messages/);
  assert.match(apiSource, /dashboardMessageUnreadCount\(\)[\s\S]*\/dashboard\/messages\/unread-count/);
  assert.match(appShellSource, /count: dashboardMessageCount/);
  assert.doesNotMatch(appShellSource, /setInterval|dashboardMessagesSummary/);
});

test("background polling pauses, focus refreshes immediately and cleanup is complete", () => {
  assert.match(providerSource, /document\.visibilityState === "hidden"/);
  assert.match(providerSource, /document\.visibilityState === "visible"[\s\S]*loadCount\(false\)/);
  assert.match(providerSource, /window\.addEventListener\("focus", handleWindowFocus\)/);
  assert.match(providerSource, /window\.clearInterval\(intervalId\)/);
  assert.match(providerSource, /document\.removeEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(providerSource, /window\.removeEventListener\("focus", handleWindowFocus\)/);
  assert.match(providerSource, /requestInFlight/);
  assert.match(providerSource, /refreshQueued/);
});

test("refresh errors preserve the last count and every local dismiss revalidates centrally", () => {
  assert.match(providerSource, /catch \{[\s\S]*Keep the last known count/);
  assert.doesNotMatch(providerSource, /catch \{[\s\S]{0,180}setState\([^)]*count:\s*0/);
  assert.equal(
    (dashboardSource.match(/await api\.dismissDashboardMessage\(message\.message_key\);/g) ?? []).length,
    3,
  );
  assert.equal(
    (dashboardSource.match(/refreshDashboardMessageCount\(\);/g) ?? []).length,
    3,
  );
  assert.match(dashboardSource, /badge=\{dashboardMessageCount > 0 \? String\(dashboardMessageCount\) : undefined\}/);
});

test("dashboard message details reload only after the lightweight count actually changes", () => {
  assert.match(dashboardSource, /dashboardMessageListCountRef\.current === dashboardMessageCount/);
  assert.match(dashboardSource, /dashboardMessageCountInitialized/);
  assert.match(dashboardSource, /refreshDashboardMessageList/);
  assert.match(dashboardSource, /dashboardMessageListCountRef\.current = summary\.open_count/);
  assert.match(dashboardSource, /setDashboardMessages\(summary\.latest_messages\)/);
});
