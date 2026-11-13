#!/usr/bin/env node
// Test permission-gate patterns
// NOTE: keep in sync with ~/.pi/agent/extensions/permission-gate.ts
// Mirrors RM_FLAGS in permission-gate/index.ts.
const RM_FLAGS = String.raw`(?:-\S+\s+)*(?:-[a-z]*r[a-z]*|--recursive)(?:\s+-\S+)*`;

const patterns = [
  // ── File-system destruction
  new RegExp(String.raw`\brm\s+(?:-[a-z]*r[a-z]*|--recursive)`, "i"),
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /:+\s*>\s*\S/,               // truncate redirection
  /\bfind\b.*\s-(exec|delete)\b/i,
  // ── Privilege escalation / permission changes
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
  // ── npm / npx global destructive
  /\bnpx\s+skills.*\bremove\b.*(--all|'\*')/i,
  /\bnpm\s+(uninstall|remove|rm)\b.*-g/i,
  /\bnpx\s+.*\b(uninstall|remove)\b.*--all/i,
  // ── Git destructive (--force-with-lease is the SAFE force push - not gated)
  /\bgit\s+push\b.*(--force(?!-with-lease)|-f)\b/i,
  /\bgit\s+push\b[^\n]*\s\+[^\s]+/i, // leading `+` refspec = unconditional force
  /\bgit\s+reset\b.*--hard/i,
  /\bgit\s+clean\b.*-f/i,
  /\bgit\s+branch\b.*-D\b/i,
  // ── Shell redirect overwrite (excludes /dev/null)
  />\s*\/(dev(?!\/null\b)|etc|proc|sys)/i,
  // ── System shutdown / halt (also hard-deny floor item)
  /\b(shutdown|reboot|halt|poweroff)(\s|\n|$)/i,
];

// ── hard-deny floor (mirror of isHardDeny in permission-gate.ts) ──
const hardDenyPatterns = [
  new RegExp(String.raw`\bsudo\b.*\brm\s+(?:-[a-z]*r[a-z]*|--recursive)`, "i"),
  new RegExp(String.raw`\brm\s+${RM_FLAGS}\s+["']?\/+\.{0,2}\/?(?:\s|$|["';|&])`, "i"),
  new RegExp(
    String.raw`\brm\s+${RM_FLAGS}\s+["']?\/[^\/\s"';|&]+\/(?:[^\/\s"';|&]*\/)?\.\.(?:\s|$|["';|&])`,
    "i",
  ),
  new RegExp(String.raw`\brm\s+${RM_FLAGS}\s+\.?\s*\*`, "i"),
  new RegExp(String.raw`\brm\s+${RM_FLAGS}\s+\/+\*`, "i"),
  /\bdd\s+if=.*\sof=\s*\/dev\/(zero|xv?a?d[a-z]|sd[a-z]|rdisk)/i,
  /\bmkfs(\.|\s)/i,
  /:\s*>\s*\/etc(\s|$)/i,
  /(^|[;|&]\s*|sudo\s+)\b(shutdown|reboot|poweroff|halt)\b(\s|$)/i,
];
function isGitForcePushToMain(cmd) {
  if (!/\bgit\s+push\b/i.test(cmd)) return false;
  const afterPush = cmd.replace(/^.*?\bgit\s+push\b/i, "");
  const tokens = afterPush.trim().split(/[\s;|&]+/).filter(Boolean);
  let lastForce = "none";
  for (const tok of tokens) {
    if (tok === "--force" || tok === "-f") lastForce = "plain";
    else if (tok === "--force-with-lease") lastForce = "lease";
  }
  if (tokens.includes("--mirror")) return true;
  if (lastForce === "plain" && tokens.includes("--all")) return true;
  const mainLike = (t) => {
    const bare = t.replace(/^\+/, "").split(/[:/]/).pop();
    return /^(master|main)$/i.test(bare);
  };
  for (const tok of tokens) {
    if (tok.startsWith("--")) continue;
    if (/^(-u|-v|--verbose|--porcelain|--set-upstream)$/i.test(tok)) continue;
    if (!mainLike(tok)) continue;
    if (tok.startsWith("+")) return true;
    if (lastForce === "plain") return true;
  }
  return false;
}
function isHardDeny(cmd) {
  return hardDenyPatterns.some((p) => p.test(cmd)) || isGitForcePushToMain(cmd);
}

const tests = [
  // ===== hard-deny safety floor (always blocked, even in YOLO) =====
  ["HARDDENY", "sudo rm -rf /", "sudo rm -rf /"],
  ["HARDDENY", "rm -rf /", "rm -rf /"],
  ["HARDDENY", "rm -rf *", "rm -rf *"],
  ["HARDDENY", "dd to /dev/sda", "dd if=/dev/zero of=/dev/sda"],
  ["HARDDENY", "mkfs", "mkfs.ext4 /dev/sdb1"],
  ["HARDDENY", "push --force origin main", "git push --force origin main"],
  ["HARDDENY", "push -f origin main", "git push -f origin main"],
  ["HARDDENY", "push --force HEAD:master", "git push --force origin HEAD:master"],
  ["HARDDENY", "push origin main --force (flag after)", "git push origin main --force"],
  ["HARDDENY", "push HEAD:master -f (flag after)", "git push origin HEAD:master -f"],
  ["HARDDENY", "shutdown", "shutdown -h now"],
  ["HARDDENY", "poweroff", "poweroff"],
  ["HARDDENY", "reboot after ;", "cd /tmp && reboot"],
  ["HARDDENY", "halt", "halt"],
  ["HARDDENY", "push main as 2nd refspec", "git push -f origin feature-branch main"],
  ["HARDDENY", "push refs/heads/main", "git push --force origin refs/heads/main"],
  // ── round-1 review fixes ──
  ["HARDDENY", "lease then plain -f (force wins)", "git push origin main --force-with-lease -f"],
  ["HARDDENY", "lease then --force (force wins)", "git push --force-with-lease origin main --force"],
  ["HARDDENY", "+main refspec (unconditional force)", "git push origin +main"],
  ["HARDDENY", "+refs/heads/main refspec", "git push origin +refs/heads/main"],
  ["HARDDENY", "--all + --force rewrites all branches", "git push --all -f origin"],
  ["HARDDENY", "--mirror: force-by-definition", "git push -f --mirror origin"],
  ["HARDDENY", "bare --mirror", "git push --mirror origin"],
  ["HARDDENY", "custom remote name (bitbucket)", "git push -f bitbucket main"],
  ["HARDDENY", "custom remote name (fork)", "git push -f fork main"],
  ["HARDDENY", "rm -rf // (root variant)", "rm -rf //"],
  ["HARDDENY", "rm -rf /. (root variant)", "rm -rf /."],
  ["HARDDENY", "rm -rf /./", "rm -rf /./"],
  ["HARDDENY", "rm -rf quoted root", "rm -rf \"/\""],
  ["HARDDENY", "rm -rf single-quoted root", "rm -rf '/"],
  ["HARDDENY", "rm -rf /;sleep 1 (sep)", "rm -rf /;sleep 1"],
  ["HARDDENY", "rm -rf /|wc (sep)", "rm -rf /|wc"],
  ["HARDDENY", "rm -rf /& (sep)", "rm -rf /&"],
  ["HARDDENY", "rm -rf /tmp/.. (traversal)", "rm -rf /tmp/.."],
  ["HARDDENY", "rm -rf /a/b/.. (traversal)", "rm -rf /a/b/.."],
  // ── flag reordering / separation / root glob (were silent bypasses) ──
  ["HARDDENY", "rm -fr / (reordered flags)", "rm -fr /"],
  ["HARDDENY", "sudo rm -fr / (reordered, sudo)", "sudo rm -fr /"],
  ["HARDDENY", "rm -Rf / (capital R)", "rm -Rf /"],
  ["HARDDENY", "rm -r -f / (separated flags)", "rm -r -f /"],
  ["HARDDENY", "rm -f -r / (recursive last)", "rm -f -r /"],
  ["HARDDENY", "rm -rf /* (root glob)", "rm -rf /*"],
  ["HARDDENY", "rm -fr /* (root glob, reordered)", "rm -fr /*"],
  ["FLOORSAFE", "floor: rm -fr ./build (relative)", "rm -fr ./build"],
  ["FLOORSAFE", "floor: rm -r -f /tmp/junk (not root)", "rm -r -f /tmp/junk"],
  ["FLOORSAFE", "floor: rm -rf /tmp/* (not root glob)", "rm -rf /tmp/*"],
  ["FLOORSAFE", "floor: rm --interactive (no recursive)", "rm --interactive file"],
  // floor-safe: these LOOK dangerous but must NOT trip the hard-deny floor
  // (they may still trip the dangerous-gate; that is fine, handled below)
  ["FLOORSAFE", "floor: rm -rf /tmp (not root)", "rm -rf /tmp/junk"],
  ["FLOORSAFE", "floor: force push feature branch", "git push --force origin feature/x"],
  ["FLOORSAFE", "floor: reboot-service (word boundary)", "npm run reboot-service"],
  ["FLOORSAFE", "floor: cat shutdown.log", "cat shutdown.log"],
  ["FLOORSAFE", "floor: echo shutdown-app", "echo shutdown-app"],
  ["FLOORSAFE", "floor: npm run shutdown-script", "npm run shutdown-script"],
  ["FLOORSAFE", "floor: ./my-shutdown-script.sh", "./my-shutdown-script.sh"],
  ["FLOORSAFE", "floor: lease last is effective (SAFE)", "git push origin main -f --force-with-lease"],
  ["FLOORSAFE", "floor: git fetch +main (not a push)", "git fetch origin +main"],
  ["FLOORSAFE", "floor: git fetch +refs/heads/main", "git fetch origin +refs/heads/main"],
  ["FLOORSAFE", "floor: git pull origin main", "git pull origin main"],
  ["FLOORSAFE", "floor: rm -rf /var/log (safe descendant)", "rm -rf /var/log"],
  ["FLOORSAFE", "floor: rm -rf /home (safe descendant)", "rm -rf /home"],
  // safe: lease protected push to main is NOT hard-deny
  ["PASS", "safe: --force-with-lease to main", "git push --force-with-lease origin main"],
  ["PASS", "safe: -u --force-with-lease to main", "git push -u origin main --force-with-lease"],
  // safe vs dangerous distinction at the GATE level (these ARE dangerous,
  // they trigger confirmation; "safe" only below the hard-deny floor in YOLO)
  ["BLOCK", "force push to feature branch (gate trips)", "git push origin feature/x --force"],
  ["BLOCK", "reset --hard origin remote (gate trips)", "git reset --hard origin/main"],
  ["BLOCK", "push --force develop (gate trips)", "git push --force origin develop"],
  // ===== PASS =====
  ["PASS", "safe: find + 2>/dev/null",       'find /tmp -name "*.sqlite" 2>/dev/null | head -10'],
  ["PASS", "safe: cmd 2>/dev/null",          "some_cmd 2>/dev/null"],
  ["PASS", "safe: plain find",               "find . -name '*.ts'"],
  ["PASS", "safe: npm install",              "npm install lodash"],
  ["PASS", "safe: git status",               "git status"],
  ["PASS", "safe: npm rm (no -g)",           "npm rm lodash"],
  ["PASS", "safe: npx skills list",          "npx skills list"],
  // 2>/dev/null in multi-commands (should not false-positive)
  ["PASS", "safe: 2>/dev/null; echo",        "cmd 2>/dev/null; echo done"],
  ["PASS", "safe: 2>/dev/null; cmd",         "ls 2>/dev/null; cat /foo"],
  ["PASS", "safe: multi cmd + 2>/dev/null",  "cd /tmp && grep -r x . 2>/dev/null; cat f 2>/dev/null | head"],
  // ===== new: safe force-push with lease (must NOT false-positive) =====
  ["PASS", "safe: --force-with-lease",       "git push --force-with-lease origin main"],
  ["PASS", "safe: push -u with lease",       "git push -u origin main --force-with-lease"],
  // Plain -f alongside lease is still unconditional force - correctly BLOCKed
  ["BLOCK", "plain -f + lease (redundant)",  "git push origin main -f --force-with-lease"],
  // leading `+` refspec is an unconditional force push -> gate trips
  ["BLOCK", "+main refspec (gate trips)",     "git push origin +main"],

  // ===== BLOCK: File-system destruction =====
  ["BLOCK", "rm -rf",                        "rm -rf /tmp/x"],
  ["BLOCK", "rm --recursive",                "rm --recursive /tmp/x"],
  ["BLOCK", "dd if=",                        "dd if=/dev/zero of=/tmp/test"],
  ["BLOCK", "mkfs.ext4",                     "mkfs.ext4 /dev/sda1"],
  ["BLOCK", "colon > truncate with space",   ": > /tmp/test"],
  ["BLOCK", "colon truncate no space",       ":>/tmp/test"],
  ["BLOCK", "find -delete",                  "find . -name tmp -delete"],
  ["BLOCK", "find -exec",                    "find . -name tmp -exec rm {} ;"],

  // ===== BLOCK: Privilege escalation =====
  ["BLOCK", "sudo",                          "sudo ls"],
  ["BLOCK", "chmod 777",                     "chmod 777 file"],
  ["BLOCK", "chown 777",                     "chown 777:777 file"],

  // ===== BLOCK: npm / npx global destructive =====
  ["BLOCK", "npx skills remove --all",       "npx skills remove --all"],
  ["BLOCK", "npx skills remove '*",          "npx skills remove '*'"],
  ["BLOCK", "npm uninstall -g",              "npm uninstall some-pkg -g"],
  ["BLOCK", "npm remove -g",                 "npm remove some-pkg -g"],
  ["BLOCK", "npm rm -g",                     "npm rm some-pkg -g"],
  ["BLOCK", "npx foo uninstall --all",       "npx some-tool uninstall --all"],
  ["BLOCK", "npx foo remove --all",          "npx some-tool remove --all"],

  // ===== BLOCK: Git destructive =====
  ["BLOCK", "git push --force",              "git push --force origin main"],
  ["BLOCK", "git push -f",                   "git push -f"],
  ["BLOCK", "git push -f origin main",       "git push -f origin main"],
  ["BLOCK", "git push --all -f origin",      "git push --all -f origin"],
  ["BLOCK", "git push -f --mirror origin",   "git push -f --mirror origin"],
  ["BLOCK", "git push -f bitbucket main",    "git push -f bitbucket main"],
  // note: bare `git push --mirror origin` is HARDDENY (floor) but has no
  // force flag, so the confirmation gate does NOT trip for it — floor-only.
  ["BLOCK", "git reset --hard",              "git reset --hard HEAD~1"],
  ["BLOCK", "git clean -fd",                 "git clean -fd"],
  ["BLOCK", "git clean -f",                  "git clean -f"],
  ["BLOCK", "git branch -D",                 "git branch -D feature-x"],

  // ===== BLOCK: Shell redirect overwrite =====
  ["BLOCK", "> /dev/sda",                    "echo data > /dev/sda"],
  ["BLOCK", "> /dev/sda1",                   "dd if=/dev/zero of=/dev/sda1"],
  ["BLOCK", "> /dev/sdb",                    "dd if=/dev/zero of=/dev/sdb"],
  ["BLOCK", "> /dev/disk0",                  "dd if=/dev/zero of=/dev/disk0"],
  ["BLOCK", "> /dev/zero",                   "dd if=/dev/random of=/dev/zero"],
  ["BLOCK", "> /etc/hosts",                  "cat > /etc/hosts"],
  ["BLOCK", "> /etc/passwd",                 "echo x > /etc/passwd"],
  ["BLOCK", "> /proc/sys/",                  "echo 1 > /proc/sys/net/ipv4/ip_forward"],
  ["BLOCK", "> /sys/class/",                 "echo 1 > /sys/class/leds/input1/brightness"],
  // /dev/null-* is a contrived edge: /dev/null-foo is not a real device.
  // \b-based exclusion lets this through; acceptable given no real-world risk.
  ["PASS", "KNOWN: /dev/null- (not a real device)", "echo data > /dev/null-but-not-really"],
  ["BLOCK", "> /dev/nullsuffix",              "echo data > /dev/nullsuffix"],
  ["BLOCK", "> /dev/null0",                   "echo data > /dev/null0"],
  ["BLOCK", "> /dev/sda",                    "echo x >/dev/sda"],
  ["BLOCK", "> /dev/sda",                    "echo x > /dev/sda 2>/dev/null"],
  ["BLOCK", "> /proc/mixed",                 "echo x > /proc/sysrq-trigger 2>/dev/null; echo ok"],

  // ===== PASS: /dev/null edges (must NOT false-positive) =====
  ["PASS", "safe: 2>/dev/null |",            "cmd 2>/dev/null | tee log"],
  ["PASS", "safe: 2>/dev/null &",            "cmd 2>/dev/null &"],
  ["PASS", "safe: 2>/dev/null &&",           "cmd 2>/dev/null && echo ok"],
  ["PASS", "safe: 2>/dev/null ||",           "cmd 2>/dev/null || echo fail"],
  ["PASS", "safe: 2>/dev/null; cmd",         "cmd 2>/dev/null; cat /foo"],
  ["PASS", "safe: 2>/dev/null\nnext",        "cmd 2>/dev/null\nnext"],
  ["PASS", "safe: 2>/dev/null(semicolon)",   "cmd 2>/dev/null"],
  ["PASS", "safe: >/dev/null",               "cmd >/dev/null 2>&1"],
  ["PASS", "safe: 2>/dev/null redirect",     "cmd >out 2>/dev/null"],
  ["PASS", "safe: /dev/null in path",        "cat /dev/null 2>/dev/null"],
  ["PASS", "safe: empty /dev/null",          ">/dev/null"],
  ["PASS", "safe: complex multi",            "cd /tmp && grep -r x . 2>/dev/null; grep -r y . 2>/dev/null | head; echo done"],
];

let ok = 0, fail = 0, falsePos = 0, falseNeg = 0;
for (const [expect, label, cmd] of tests) {
  const hits = patterns.filter(p => p.test(cmd));
  const gateMatched = hits.length > 0;
  if (expect === "HARDDENY") {
    // Floor-first restructure: hard-deny commands are blocked unconditionally,
    // BEFORE the dangerous-patterns gate is consulted.  So only assert the
    // floor itself (isHardDeny) — the gate may or may not also trip.
    const floor = isHardDeny(cmd) === true;
    const detail = floor ? " [floor]" : " [floor=FALSE]";
    console.log((floor ? "✓" : "✗") + " HARDDENY " + label + detail);
    if (floor) ok++; else { fail++; falseNeg++; }
    continue;
  }
  if (expect === "FLOORSAFE") {
    // Must NOT trip the floor, regardless of the dangerous gate.
    const safe = isHardDeny(cmd) === false;
    const detail = safe ? " [floor-safe]" : " [floor=BYPASSED]";
    console.log((safe ? "✓" : "✗") + " FLOORSAFE " + label + detail);
    if (safe) ok++; else { fail++; falsePos++; }
    continue;
  }
  const expectedMatch = expect === "BLOCK";
  const correct = gateMatched === expectedMatch;
  const sym = correct ? "✓" : "✗";
  const detail = gateMatched ? " [" + hits.map(h => String(h).slice(0, 40)).join(', ') + "]" : "";
  console.log(sym + " " + expect + " " + label + detail);
  if (correct) ok++; else {
    fail++;
    if (gateMatched && !expectedMatch) falsePos++;
    if (!gateMatched && expectedMatch) falseNeg++;
  }
}
console.log("\n" + ok + "/" + tests.length + " passed, " + (tests.length - ok) + " failed");
if (falsePos > 0) console.log("  False positives (safe cmd blocked): " + falsePos);
if (falseNeg > 0) console.log("  False negatives (dangerous cmd missed): " + falseNeg);
process.exit(fail > 0 ? 1 : 0);