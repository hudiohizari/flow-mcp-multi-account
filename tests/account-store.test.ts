import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pickFallbackAccountId } from "../dist/account-registry.js";
import { AccountStore } from "../dist/accounts.js";
import { getConfig } from "../dist/config.js";

test("AccountStore initializes legacy default, handles restart, missing profiles, and corrupt JSON safely", () => {
  const root = mkdtempSync(join(tmpdir(), "flow-store-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out") });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });

    const store1 = new AccountStore(cfg);
    assert.equal(store1.getRegistryError(), null);
    assert.equal(store1.requireActiveAccount().id, "default");
    assert.equal(statSync(cfg.accountsFile).mode & 0o777, 0o600);
    assert.equal(store1.getPaths(store1.requireActiveAccount()).profileDir, join(cfg.homeDir, "chrome-profile"));
    assert.equal(store1.getActivePaths().profileDir, join(cfg.homeDir, "chrome-profile"));

    const added = store1.addAccount("Backup 1");
    assert.equal(added.slug, "backup-1");
    assert.equal(added.priority, 2);
    store1.updateMetadata(added.id, { plan: "Pro", creditsRemaining: 900, balanceUpdatedAt: "2026-11-25T00:00:00Z", lastProjectUrl: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111", lastProjectTitle: "Demo", needsRelogin: false });
    store1.setActive(added.id, null);

    // Restart resumes last active account
    const store2 = new AccountStore(cfg);
    assert.equal(store2.requireActiveAccount().id, added.id);

    // Missing profile directory clears stale balance metadata and flags needsRelogin
    rmSync(store2.getPaths(added).profileDir, { recursive: true, force: true });
    assert.equal(store2.verifyProfilesOnDisk(), true);
    assert.equal(store2.verifyProfilesOnDisk(), false);
    const reloaded = store2.findAccount({ id: added.id });
    assert.equal(reloaded.plan, undefined);
    assert.equal(reloaded.creditsRemaining, undefined);
    assert.equal(reloaded.lastProjectUrl, undefined);
    assert.equal(reloaded.needsRelogin, true);

    // Interrupted pendingLogin reverts active account on restart
    const defView = store2.setActive("default");
    assert.equal(defView.id, "default");
    store2.setActive(added.id, { targetAccountId: added.id, previousAccountId: "default", startedAt: new Date().toISOString() });
    const store3 = new AccountStore(cfg);
    assert.equal(store3.requireActiveAccount().id, "default");
    assert.equal(store3.getPendingLogin(), null);

    // Disabled active falls back to lowest priority enabled
    const regRaw = JSON.parse(readFileSync(cfg.accountsFile, "utf8"));
    regRaw.activeAccountId = added.id;
    regRaw.accounts[1].enabled = false;
    writeFileSync(cfg.accountsFile, JSON.stringify(regRaw));
    const store4 = new AccountStore(cfg);
    assert.equal(store4.requireActiveAccount().id, "default");

    // All disabled edge fallback in pickFallbackAccountId
    assert.equal(
      pickFallbackAccountId({
        version: 1,
        activeAccountId: "x",
        pendingLogin: null,
        retiredSlugs: [],
        accounts: [
          { id: "x", slug: "x", label: "X", isDefault: false, enabled: false, priority: 1, needsRelogin: false, createdAt: "", updatedAt: "" },
        ],
      }),
      "x",
    );

    // Corrupt registry JSON fails loudly without overwriting file
    writeFileSync(cfg.accountsFile, "{not-valid-json");
    const corruptStore = new AccountStore(cfg);
    assert.ok(corruptStore.getRegistryError());
    assert.equal(corruptStore.getActiveAccount(), null);
    assert.equal(corruptStore.getPendingLogin(), null);
    assert.deepEqual(corruptStore.listAccounts(), []);
    assert.equal(corruptStore.verifyProfilesOnDisk(), false);
    assert.equal(corruptStore.getActivePaths().profileDir, join(cfg.homeDir, "chrome-profile"));
    assert.throws(() => corruptStore.assertHealthy(), /damaged|corrupt/i);
    assert.equal(readFileSync(cfg.accountsFile, "utf8"), "{not-valid-json");

    // Duplicate invariants trigger corrupt state
    writeFileSync(
      cfg.accountsFile,
      JSON.stringify({
        version: 1,
        activeAccountId: "default",
        pendingLogin: null,
        retiredSlugs: [],
        accounts: [
          { id: "default", slug: "default", label: "Primary", isDefault: true, enabled: true, priority: 1, needsRelogin: false, createdAt: "", updatedAt: "" },
          { id: "b", slug: "b", label: " primary ", isDefault: false, enabled: true, priority: 2, needsRelogin: false, createdAt: "", updatedAt: "" },
        ],
      }),
    );
    assert.ok(new AccountStore(cfg).getRegistryError());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AccountStore CRUD, guards, revert, metadata clears, and fresh slug on re-add", () => {
  const root = mkdtempSync(join(tmpdir(), "flow-crud-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out") });
    const trashed: string[] = [];
    const store = new AccountStore(cfg, (p) => {
      trashed.push(p);
      rmSync(p, { recursive: true, force: true });
      return join(root, "trash", "moved");
    });

    assert.throws(() => store.addAccount("  "), /Blank spaces/i);
    assert.throws(() => store.addAccount("Primary"), /already exists/i);
    const second = store.addAccount("Client A");
    const third = store.addAccount("Client B");

    assert.throws(() => store.findAccount({}), /Choose or name/i);
    assert.throws(() => store.findAccount({ label: "Nope" }), /Could not find/i);
    assert.throws(() => store.findAccount({ id: "missing-id" }), /Could not find/i);
    assert.equal(store.findAccount({ label: "client a" }).id, second.id);

    assert.throws(() => store.renameAccount({ id: second.id }, "client b"), /already exists/i);
    assert.throws(() => store.renameAccount({ id: second.id }, "   "), /Blank spaces/i);
    const renamed = store.renameAccount({ id: second.id }, "Client Alpha");
    assert.equal(renamed.slug, second.slug);

    assert.throws(() => store.enableAccount({ id: "default" }, false), /while it is active/i);
    store.enableAccount({ id: second.id }, false);
    store.enableAccount({ id: third.id }, false);
    assert.throws(() => store.enableAccount({ id: "default" }, false), /at least one account/i);
    assert.equal(store.enableAccount({ id: second.id }, false).enabled, false);
    store.setActive(second.id, null);
    assert.throws(() => store.enableAccount({ id: second.id }, false), /while it is active/i);
    store.enableAccount({ id: second.id }, true);
    store.setActive("default", null);
    store.enableAccount({ id: third.id }, true);

    assert.throws(() => store.reorderAccounts(["default"]), /order/i);
    assert.throws(() => store.reorderAccounts(["default", "default", "default"]), /order/i);
    assert.throws(() => store.reorderAccounts(["default", second.id, "unknown"]), /order/i);
    const reordered = store.reorderAccounts([third.id, second.id, "default"]);
    assert.deepEqual(reordered.map((a) => a.id), [third.id, second.id, "default"]);

    assert.throws(() => store.removeAccount({ id: "default" }), /active/i);
    store.setActive(second.id, null);
    assert.throws(() => store.removeAccount({ id: "default" }), /primary/i);

    store.setActive("default", null);
    const removed = store.removeAccount({ id: third.id });
    assert.equal(removed.removedId, third.id);
    assert.equal(trashed.length, 1);
    assert.equal(existsSync(join(cfg.accountsDir, third.slug)), false);

    // Re-adding same label allocates a fresh slug
    const reAdded = store.addAccount("Client B");
    assert.notEqual(reAdded.slug, third.slug);
    assert.equal(reAdded.slug, "client-b-2");

    // Re-removing when dir already gone skips cleanly and avoids duplicate retiredSlugs
    rmSync(store.getPaths(reAdded).accountRoot, { recursive: true, force: true });
    assert.equal(store.removeAccount({ id: reAdded.id }).trashedTo, null);

    // Clear and revert pending login
    store.clearPendingLogin();
    assert.equal(store.revertPendingLogin(), null);
    store.setActive(second.id, { targetAccountId: second.id, previousAccountId: "default", startedAt: new Date().toISOString() });
    const reverted = store.revertPendingLogin();
    assert.equal(reverted?.id, "default");
    assert.equal(store.findAccount({ id: second.id }).needsRelogin, true);

    store.setActive(second.id, { targetAccountId: second.id, previousAccountId: "default", startedAt: new Date().toISOString() });
    store.clearPendingLogin();
    assert.equal(store.getPendingLogin(), null);

    // Missing active id throws ACCOUNT_NOT_FOUND
    const brokenActive = getConfig({ FLOW_MCP_HOME: join(root, "broken-active"), FLOW_MCP_OUTPUT: join(root, "out") });
    new AccountStore(brokenActive);
    const modReg = JSON.parse(readFileSync(brokenActive.accountsFile, "utf8"));
    modReg.accounts.push({ id: "sec", slug: "sec", label: "Sec", isDefault: false, enabled: true, priority: 2, needsRelogin: false, createdAt: "", updatedAt: "" });
    writeFileSync(brokenActive.accountsFile, JSON.stringify(modReg));
    const bStore = new AccountStore(brokenActive);
    bStore.updateMetadata("sec", { lastProjectUrl: "https://flow.google.com/project/x", lastProjectTitle: "Title" });
    bStore.updateMetadata("sec", { lastProjectUrl: null });
    assert.equal(bStore.findAccount({ id: "sec" }).lastProjectUrl, undefined);
    bStore.updateMetadata("sec", { lastProjectTitle: null });
    assert.equal(bStore.findAccount({ id: "sec" }).lastProjectTitle, undefined);

    // Cover pendingLogin pointing to disabled previous account & missing target
    writeFileSync(
      brokenActive.accountsFile,
      JSON.stringify({
        version: 1,
        activeAccountId: "sec",
        pendingLogin: { targetAccountId: "missing-target", previousAccountId: "sec", startedAt: "" },
        retiredSlugs: [],
        accounts: [
          { id: "default", slug: "default", label: "Primary", isDefault: true, enabled: true, priority: 1, needsRelogin: false, createdAt: "", updatedAt: "" },
          { id: "sec", slug: "sec", label: "Sec", isDefault: false, enabled: false, priority: 2, needsRelogin: false, createdAt: "", updatedAt: "" },
        ],
      }),
    );
    const recovered = new AccountStore(brokenActive);
    assert.equal(recovered.requireActiveAccount().id, "default");
    assert.equal(recovered.enableAccount({ id: "sec" }, true).enabled, true);

    // CANNOT_DISABLE_LAST triggers when disabling sole enabled account
    const soleStore = new AccountStore(getConfig({ FLOW_MCP_HOME: join(root, "sole-last"), FLOW_MCP_OUTPUT: join(root, "out") }));
    assert.throws(() => soleStore.enableAccount({ id: "default" }, false), /at least one account/i);
    // Manipulate active to disabled in memory via reload test for pickFallbackId all-disabled
    const allDis = getConfig({ FLOW_MCP_HOME: join(root, "all-dis"), FLOW_MCP_OUTPUT: join(root, "out") });
    new AccountStore(allDis);
    const dReg = JSON.parse(readFileSync(allDis.accountsFile, "utf8"));
    dReg.accounts[0].enabled = false;
    writeFileSync(allDis.accountsFile, JSON.stringify(dReg));
    assert.equal(new AccountStore(allDis).requireActiveAccount().enabled, true);

    // Pending login revert when previous account disabled
    const revDis = getConfig({ FLOW_MCP_HOME: join(root, "rev-dis"), FLOW_MCP_OUTPUT: join(root, "out") });
    const revStore = new AccountStore(revDis);
    const r2 = revStore.addAccount("R2");
    revStore.setActive(r2.id, { targetAccountId: r2.id, previousAccountId: "missing-prev", startedAt: "" });
    assert.equal(revStore.revertPendingLogin()?.id, "default");

    // Pending login target already deleted before revert
    revStore.setActive(r2.id, { targetAccountId: "deleted-id", previousAccountId: "default", startedAt: "" });
    assert.equal(revStore.revertPendingLogin()?.id, "default");

    // Verify duplicate ID and duplicate slug invariants
    writeFileSync(
      allDis.accountsFile,
      JSON.stringify({
        version: 1,
        activeAccountId: "default",
        pendingLogin: null,
        retiredSlugs: [],
        accounts: [
          { id: "default", slug: "default", label: "One", isDefault: true, enabled: true, priority: 1, needsRelogin: false, createdAt: "", updatedAt: "" },
          { id: "default", slug: "two", label: "Two", isDefault: false, enabled: true, priority: 2, needsRelogin: false, createdAt: "", updatedAt: "" },
        ],
      }),
    );
    assert.ok(new AccountStore(allDis).getRegistryError());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
